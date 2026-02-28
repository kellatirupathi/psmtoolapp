import { useRef, useState } from "react";
import { cancelJob, getDrilldownSampleTemplateUrl, startDrilldownJob } from "../api/client";
import { ResultTable } from "../components/ResultTable";
import { downloadCsv, rowsToCsv } from "../utils/csv";
import {
  notifyJobCompleted,
  notifyJobFailed,
  requestDesktopNotificationPermission,
} from "../utils/desktopNotifications";
import {
  isJobCancelledByUserError,
  isPollingAbortedError,
  waitForJobCompletion,
} from "../utils/jobPolling";
import { parseCsvRows } from "../utils/parsers";
import type { AiProvider, ApiResult, JobProgress } from "../types";

export function DrilldownPage({
  product,
  provider,
  onProviderChange,
}: {
  product: string;
  provider: AiProvider;
  onProviderChange: (provider: AiProvider) => void;
}) {
  const [rows, setRows] = useState<Array<Record<string, string>>>([]);
  const [result, setResult] = useState<ApiResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveStatus, setLiveStatus] = useState("");
  const [progress, setProgress] = useState<JobProgress | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const pollAbortRef = useRef<AbortController | null>(null);

  const handleCsvUpload = async (file: File): Promise<void> => {
    const text = await file.text();
    const parsed = parseCsvRows(text);
    setRows(parsed);
    setResult(null);
    setError(parsed.length === 0 ? "CSV is empty or invalid." : null);
  };

  const start = async (): Promise<void> => {
    void requestDesktopNotificationPermission();
    const pollController = new AbortController();
    pollAbortRef.current = pollController;

    try {
      setLoading(true);
      setError(null);
      setResult(null);
      setLiveStatus("Submitting drilldown job...");
      setProgress(null);
      const started = await startDrilldownJob(rows, product, provider);
      setActiveJobId(started.jobId);
      const response = await waitForJobCompletion(
        started.jobId,
        (status) => {
          setLiveStatus(status.message);
          setProgress(status.progress ?? null);
          if (status.partialResult) {
            setResult(status.partialResult);
          }
        },
        1200,
        { signal: pollController.signal },
      );
      setResult(response);
      setLiveStatus("Completed.");
      setProgress(null);
      void notifyJobCompleted({
        jobName: "Drilldown Analysis",
        rowsCount: response.rows.length,
        savedToSheet: response.savedToSheet,
        savedToBigQuery: response.savedToBigQuery,
      });
    } catch (err) {
      if (isPollingAbortedError(err)) {
        return;
      }
      if (isJobCancelledByUserError(err)) {
        setLiveStatus("Stopped by user.");
        setProgress(null);
        return;
      }
      void notifyJobFailed({ jobName: "Drilldown Analysis", errorMessage: String(err) });
      setError(String(err));
      setProgress(null);
    } finally {
      setLoading(false);
      setActiveJobId(null);
      pollAbortRef.current = null;
      setProgress(null);
    }
  };

  const stop = async (): Promise<void> => {
    if (!loading || !activeJobId) return;
    if (!window.confirm("Are you sure you want to stop?")) {
      return;
    }

    try {
      setLiveStatus("Stopping...");
      await cancelJob(activeJobId);
      pollAbortRef.current?.abort();
      setActiveJobId(null);
      setLoading(false);
      setLiveStatus("Stopped by user.");
      setProgress(null);
    } catch (err) {
      setError(String(err));
    }
  };

  const progressPercent =
    progress === null ? null : Math.min(100, Math.max(0, Math.round(progress.percent)));

  return (
    <div className="page-section">
      <section className="panel">
        <h3>Drilldown</h3>
        <div className="field-row">
          <label htmlFor="drilldown-provider">API</label>
          <select
            id="drilldown-provider"
            value={provider}
            onChange={(event) => onProviderChange(event.target.value as AiProvider)}
          >
            <option value="mistral">Mistral API</option>
            <option value="openai">OpenAI API</option>
          </select>
        </div>
        <a className="link-button" href={getDrilldownSampleTemplateUrl()} target="_blank" rel="noreferrer">
          Download Sample Template
        </a>

        <label className="file-input">
          Upload Drilldown CSV
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                void handleCsvUpload(file);
              }
            }}
          />
        </label>

        <div className="muted">Loaded candidate rows: {rows.length}</div>
        {rows.length > 0 && <ResultTable rows={rows.slice(0, 10)} maxHeight={280} />}

        <div className="button-row">
          <button className="primary-button" onClick={start} disabled={loading || rows.length === 0}>
            {loading ? "Running Drilldown Analysis..." : "Start Live Analysis"}
          </button>
          {loading && (
            <button className="danger-button" onClick={() => void stop()}>
              Stop
            </button>
          )}
        </div>
        {(loading || liveStatus) && (
          <div className={`live-status-line ${progressPercent !== null ? "with-progress" : ""}`}>
            <span className="live-status-text">{liveStatus || "Starting..."}</span>
            {progressPercent !== null && (
              <div className="live-status-progress-inline">
                <div className="live-progress-track">
                  <div className="live-progress-fill" style={{ width: `${progressPercent}%` }} />
                </div>
                <span className="live-progress-percent">{progressPercent}%</span>
              </div>
            )}
          </div>
        )}

        {error && <div className="error-box">{error}</div>}

        {result && (
          <>
            <div className="status-row">
              <span>Extracted rows: {result.rows.length}</span>
              <span>Saved to sheet: {result.savedToSheet ? "Yes" : "No"}</span>
              <span>
                Saved to BigQuery:{" "}
                {typeof result.savedToBigQuery === "boolean" ? (result.savedToBigQuery ? "Yes" : "No") : "N/A"}
              </span>
            </div>
            <button
              className="secondary-button"
              onClick={() => downloadCsv("drilldown_analysis.csv", rowsToCsv(result.rows))}
            >
              Download Final CSV
            </button>
            <ResultTable rows={result.rows} />
          </>
        )}
      </section>
    </div>
  );
}
