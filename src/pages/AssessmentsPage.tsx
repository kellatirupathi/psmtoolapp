import { useRef, useState } from "react";
import { cancelJob, startAssessmentsIndividualJob, startAssessmentsZipJob } from "../api/client";
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
import type { AiProvider, ApiResult, AssessmentIndividualRow, AssessmentZipRow } from "../types";

type AssessmentsPageProps = {
  product: string;
  provider: AiProvider;
  onProviderChange: (provider: AiProvider) => void;
};

const createZipRow = (index: number): AssessmentZipRow => ({
  fileField: `zip_file_${index}`,
  company_name: "",
  job_id: "",
  assessment_date: new Date().toISOString().slice(0, 10),
});

const createIndividualRow = (index: number): AssessmentIndividualRow => ({
  fileField: `individual_file_${index}`,
  company_name: "",
  job_id: "",
  assessment_date: new Date().toISOString().slice(0, 10),
});

export function AssessmentsPage({ product, provider, onProviderChange }: AssessmentsPageProps) {
  const [tab, setTab] = useState<"ZIP File Processor" | "Individual File Processor">("ZIP File Processor");
  const [zipRows, setZipRows] = useState<AssessmentZipRow[]>([createZipRow(0)]);
  const [individualRows, setIndividualRows] = useState<AssessmentIndividualRow[]>([createIndividualRow(0)]);
  const [result, setResult] = useState<ApiResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveStatus, setLiveStatus] = useState("");
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const pollAbortRef = useRef<AbortController | null>(null);

  const addZipRow = (): void => {
    setZipRows((prev) => [...prev, createZipRow(prev.length)]);
  };

  const addIndividualRow = (): void => {
    setIndividualRows((prev) => [...prev, createIndividualRow(prev.length)]);
  };

  const runZipAnalysis = async (): Promise<void> => {
    void requestDesktopNotificationPermission();
    const pollController = new AbortController();
    pollAbortRef.current = pollController;

    try {
      setLoading(true);
      setError(null);
      setResult(null);
      setLiveStatus("Submitting ZIP assessment job...");
      const started = await startAssessmentsZipJob(zipRows, product, provider);
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
        jobName: "Assessments ZIP Processor",
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
      void notifyJobFailed({ jobName: "Assessments ZIP Processor", errorMessage: String(err) });
      setError(String(err));
    } finally {
      setLoading(false);
      setActiveJobId(null);
      pollAbortRef.current = null;
    }
  };

  const runIndividualAnalysis = async (): Promise<void> => {
    void requestDesktopNotificationPermission();
    const pollController = new AbortController();
    pollAbortRef.current = pollController;

    try {
      setLoading(true);
      setError(null);
      setResult(null);
      setLiveStatus("Submitting individual assessment job...");
      const started = await startAssessmentsIndividualJob(individualRows, product, provider);
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
        jobName: "Assessments Individual Processor",
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
      void notifyJobFailed({ jobName: "Assessments Individual Processor", errorMessage: String(err) });
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
        <h3>Assessments</h3>
        <div className="field-row">
          <label htmlFor="assessments-provider">API</label>
          <select
            id="assessments-provider"
            value={provider}
            onChange={(event) => onProviderChange(event.target.value as AiProvider)}
          >
            <option value="mistral">Mistral API</option>
            <option value="openai">OpenAI API</option>
          </select>
        </div>

        <div className="tab-row">
          <button className={tab === "ZIP File Processor" ? "tab active" : "tab"} onClick={() => setTab("ZIP File Processor")}> 
            ZIP File Processor
          </button>
          <button
            className={tab === "Individual File Processor" ? "tab active" : "tab"}
            onClick={() => setTab("Individual File Processor")}
          >
            Individual File Processor
          </button>
        </div>

        {tab === "ZIP File Processor" ? (
          <>
            {zipRows.map((row, index) => (
              <div key={row.fileField} className="row-card">
                <div className="row-title">Company ZIP {index + 1}</div>
                <div className="form-grid three">
                  <label>
                    Company Name
                    <input
                      type="text"
                      value={row.company_name}
                      onChange={(event) => {
                        const next = [...zipRows];
                        next[index] = { ...next[index], company_name: event.target.value };
                        setZipRows(next);
                      }}
                    />
                  </label>
                  <label>
                    Job ID
                    <input
                      type="text"
                      value={row.job_id}
                      onChange={(event) => {
                        const next = [...zipRows];
                        next[index] = { ...next[index], job_id: event.target.value };
                        setZipRows(next);
                      }}
                    />
                  </label>
                  <label>
                    Assessment Date
                    <input
                      type="date"
                      value={row.assessment_date}
                      onChange={(event) => {
                        const next = [...zipRows];
                        next[index] = { ...next[index], assessment_date: event.target.value };
                        setZipRows(next);
                      }}
                    />
                  </label>
                </div>

                <label className="file-input">
                  Upload ZIP
                  <input
                    type="file"
                    accept=".zip,application/zip"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      const next = [...zipRows];
                      next[index] = { ...next[index], file };
                      setZipRows(next);
                    }}
                  />
                </label>

                {index > 0 && (
                  <button
                    className="danger-button"
                    onClick={() => setZipRows((prev) => prev.filter((_row, idx) => idx !== index))}
                  >
                    Remove Company
                  </button>
                )}
              </div>
            ))}

            <div className="button-row">
              <button className="secondary-button" onClick={addZipRow}>
                Add Company
              </button>
              <button
                className="primary-button"
                onClick={runZipAnalysis}
                disabled={loading || zipRows.filter((row) => row.file).length === 0}
              >
                {loading ? "Processing ZIP Files..." : "Start ZIP Extraction"}
              </button>
              {loading && (
                <button className="danger-button" onClick={() => void stop()}>
                  Stop
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            {individualRows.map((row, index) => (
              <div key={row.fileField} className="row-card">
                <div className="row-title">Assessment File {index + 1}</div>
                <div className="form-grid three">
                  <label>
                    Job ID
                    <input
                      type="text"
                      value={row.job_id}
                      onChange={(event) => {
                        const next = [...individualRows];
                        next[index] = { ...next[index], job_id: event.target.value };
                        setIndividualRows(next);
                      }}
                    />
                  </label>
                  <label>
                    Company Name
                    <input
                      type="text"
                      value={row.company_name}
                      onChange={(event) => {
                        const next = [...individualRows];
                        next[index] = { ...next[index], company_name: event.target.value };
                        setIndividualRows(next);
                      }}
                    />
                  </label>
                  <label>
                    Assessment Date
                    <input
                      type="date"
                      value={row.assessment_date}
                      onChange={(event) => {
                        const next = [...individualRows];
                        next[index] = { ...next[index], assessment_date: event.target.value };
                        setIndividualRows(next);
                      }}
                    />
                  </label>
                </div>

                <label className="file-input">
                  Upload File
                  <input
                    type="file"
                    accept=".pdf,.png,.jpg,.jpeg,.webp,.tiff,.bmp"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      const next = [...individualRows];
                      next[index] = { ...next[index], file };
                      setIndividualRows(next);
                    }}
                  />
                </label>

                {index > 0 && (
                  <button
                    className="danger-button"
                    onClick={() => setIndividualRows((prev) => prev.filter((_row, idx) => idx !== index))}
                  >
                    Remove Row
                  </button>
                )}
              </div>
            ))}

            <div className="button-row">
              <button className="secondary-button" onClick={addIndividualRow}>
                Add Row
              </button>
              <button
                className="primary-button"
                onClick={runIndividualAnalysis}
                disabled={loading || individualRows.filter((row) => row.file).length === 0}
              >
                {loading ? "Processing Files..." : "Submit and Analyze"}
              </button>
              {loading && (
                <button className="danger-button" onClick={() => void stop()}>
                  Stop
                </button>
              )}
            </div>
          </>
        )}
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
              onClick={() => downloadCsv("assessments_analysis.csv", rowsToCsv(result.rows))}
            >
              Download CSV
            </button>
            <ResultTable rows={result.rows} />
          </>
        )}
      </section>
    </div>
  );
}
