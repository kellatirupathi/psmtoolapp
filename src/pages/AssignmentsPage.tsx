import { useMemo, useRef, useState } from "react";
import { cancelJob, startAssignmentsJob } from "../api/client";
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
import { normalizeAssignmentsCsvRows, parseAssignmentsFromPaste, parseCsvRows } from "../utils/parsers";
import type { AiProvider, ApiResult, AssignmentInputRow } from "../types";

export function AssignmentsPage({
  product,
  provider,
  onProviderChange,
}: {
  product: string;
  provider: AiProvider;
  onProviderChange: (provider: AiProvider) => void;
}) {
  const [inputMethod, setInputMethod] = useState<"Paste Text" | "Upload CSV">("Paste Text");
  const [pasteText, setPasteText] = useState("");
  const [rows, setRows] = useState<AssignmentInputRow[]>([]);
  const [result, setResult] = useState<ApiResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveStatus, setLiveStatus] = useState("");
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const pollAbortRef = useRef<AbortController | null>(null);

  const previewRows = useMemo(
    () => rows.slice(0, 10).map((row) => ({ ...row })),
    [rows],
  );

  const parsePaste = (): void => {
    const parsed = parseAssignmentsFromPaste(pasteText);
    setRows(parsed);
    setResult(null);
    setError(parsed.length === 0 ? "Use tab-separated data with: job_id, company_name, assignment_link, assignment_date." : null);
  };

  const handleCsvUpload = async (file: File): Promise<void> => {
    const text = await file.text();
    const parsedCsv = parseCsvRows(text);
    const normalized = normalizeAssignmentsCsvRows(parsedCsv);
    setRows(normalized);
    setResult(null);
    setError(normalized.length === 0 ? "CSV is empty or missing required columns." : null);
  };

  const analyze = async (): Promise<void> => {
    void requestDesktopNotificationPermission();
    const pollController = new AbortController();
    pollAbortRef.current = pollController;

    try {
      setLoading(true);
      setError(null);
      setResult(null);
      setLiveStatus("Submitting assignments job...");
      const started = await startAssignmentsJob(rows, product, provider);
      setActiveJobId(started.jobId);
      const response = await waitForJobCompletion(
        started.jobId,
        (status) => {
          setLiveStatus(status.message);
        },
        1200,
        { signal: pollController.signal },
      );
      setResult(response);
      setLiveStatus("Completed.");
      void notifyJobCompleted({
        jobName: "Assignments Analysis",
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
        return;
      }
      void notifyJobFailed({ jobName: "Assignments Analysis", errorMessage: String(err) });
      setError(String(err));
    } finally {
      setLoading(false);
      setActiveJobId(null);
      pollAbortRef.current = null;
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
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div className="page-section">
      <section className="panel">
        <h3>Assignments</h3>
        <div className="field-row">
          <label htmlFor="assignments-provider">API</label>
          <select
            id="assignments-provider"
            value={provider}
            onChange={(event) => onProviderChange(event.target.value as AiProvider)}
          >
            <option value="mistral">Mistral API</option>
            <option value="openai">OpenAI API</option>
          </select>
        </div>

        <div className="inline-controls">
          <label>
            <input
              type="radio"
              checked={inputMethod === "Paste Text"}
              onChange={() => setInputMethod("Paste Text")}
            />
            Paste Text
          </label>
          <label>
            <input
              type="radio"
              checked={inputMethod === "Upload CSV"}
              onChange={() => setInputMethod("Upload CSV")}
            />
            Upload CSV
          </label>
        </div>

        {inputMethod === "Paste Text" ? (
          <>
            <textarea
              className="textarea"
              value={pasteText}
              onChange={(event) => setPasteText(event.target.value)}
              placeholder="JOB_123\tGoogle\thttps://docs.google.com/...\t2023-10-27"
            />
            <button className="secondary-button" onClick={parsePaste}>
              Parse Pasted Data
            </button>
          </>
        ) : (
          <label className="file-input">
            Upload CSV
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
        )}

        <div className="muted">Preview rows: {rows.length}</div>
        {previewRows.length > 0 && <ResultTable rows={previewRows} maxHeight={280} />}

        <div className="button-row">
          <button className="primary-button" onClick={analyze} disabled={loading || rows.length === 0}>
            {loading ? "Analyzing Assignments..." : "Analyze Assignments"}
          </button>
          {loading && (
            <button className="danger-button" onClick={() => void stop()}>
              Stop
            </button>
          )}
        </div>
        {(loading || liveStatus) && <div className="live-status-line">{liveStatus || "Starting..."}</div>}

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
              onClick={() => downloadCsv("assignments_analysis.csv", rowsToCsv(result.rows))}
            >
              Download Analysis CSV
            </button>
            <ResultTable rows={result.rows} />
          </>
        )}
      </section>
    </div>
  );
}
