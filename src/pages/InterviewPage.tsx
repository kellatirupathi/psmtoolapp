import { useMemo, useRef, useState } from "react";
import { cancelJob, startInterviewAnalyzerJob, startVideoUploaderJob } from "../api/client";
import { ResultTable } from "../components/ResultTable";
import { ValidationPanel } from "../components/ValidationPanel";
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
import {
  normalizeInterviewCsvRows,
  parseCsvRows,
  parseInterviewRowsFromPaste,
  parseVideoMetadataFromCsvRows,
  parseVideoMetadataFromPaste,
} from "../utils/parsers";
import {
  validateInterviewRows,
  validateVideoUploaderMetadata,
  type ValidationReport,
} from "../utils/validators";
import type { AiProvider, ApiResult, InterviewInputRow, JobProgress, VideoUploaderMetadata } from "../types";

type InterviewPageProps = {
  product: string;
  modules: string[];
  selectedModule: string;
  onModuleChange: (module: string) => void;
  provider: AiProvider;
  onProviderChange: (provider: AiProvider) => void;
};

const defaultModules = ["Interview_analyser", "Video_uploader"];

function InterviewAnalyzerModule({ product, provider }: { product: string; provider: AiProvider }) {
  const [inputMethod, setInputMethod] = useState<"Paste Text" | "Upload CSV">("Paste Text");
  const [pasteText, setPasteText] = useState("");
  const [rows, setRows] = useState<InterviewInputRow[]>([]);
  const [validationReport, setValidationReport] = useState<ValidationReport<InterviewInputRow> | null>(null);
  const [result, setResult] = useState<ApiResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveStatus, setLiveStatus] = useState("");
  const [downloadProgress, setDownloadProgress] = useState<JobProgress | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const pollAbortRef = useRef<AbortController | null>(null);

  const previewRows = useMemo(
    () => rows.slice(0, 10).map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, String(v ?? "")]))),
    [rows],
  );

  const handleParsePaste = (): void => {
    const parsed = parseInterviewRowsFromPaste(pasteText);
    const report = validateInterviewRows(parsed);
    setRows(parsed);
    setValidationReport(report);
    setResult(null);
    if (parsed.length === 0) {
      setError("Expected 8, 9, or 10 tab-separated columns per row.");
      return;
    }

    setError(
      report.summary.errors > 0
        ? "Pre-flight validation found errors. Fix input before starting."
        : null,
    );
  };

  const handleCsvUpload = async (file: File): Promise<void> => {
    const text = await file.text();
    const parsedCsv = parseCsvRows(text);
    const normalized = normalizeInterviewCsvRows(parsedCsv);
    const report = validateInterviewRows(normalized);
    setRows(normalized);
    setValidationReport(report);
    setResult(null);
    if (normalized.length === 0) {
      setError("CSV is empty or missing required drive_file_id/interview_date columns.");
      return;
    }

    setError(
      report.summary.errors > 0
        ? "Pre-flight validation found errors. Fix input before starting."
        : null,
    );
  };

  const startAnalysis = async (): Promise<void> => {
    const report = validationReport ?? validateInterviewRows(rows);
    if (!validationReport) {
      setValidationReport(report);
    }
    if (report.summary.errors > 0) {
      setError("Pre-flight validation has errors. Please fix them before starting.");
      return;
    }

    void requestDesktopNotificationPermission();
    const pollController = new AbortController();
    pollAbortRef.current = pollController;

    try {
      setLoading(true);
      setError(null);
      setResult(null);
      const submittingMessage = "Submitting interview analyzer job...";
      setLiveStatus(submittingMessage);
      setDownloadProgress(null);
      const started = await startInterviewAnalyzerJob(rows, product, provider);
      setActiveJobId(started.jobId);
      const response = await waitForJobCompletion(
        started.jobId,
        (status) => {
          setLiveStatus(status.message);
          setDownloadProgress(status.progress ?? null);
          if (status.partialResult) {
            setResult(status.partialResult);
          }
        },
        1200,
        { signal: pollController.signal },
      );
      setResult(response);
      setLiveStatus("Completed.");
      setDownloadProgress(null);
      void notifyJobCompleted({
        jobName: "Interview Analyzer",
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
        setDownloadProgress(null);
        return;
      }
      void notifyJobFailed({ jobName: "Interview Analyzer", errorMessage: String(err) });
      setError(String(err));
      setDownloadProgress(null);
    } finally {
      setLoading(false);
      setActiveJobId(null);
      pollAbortRef.current = null;
      setDownloadProgress(null);
    }
  };

  const stopAnalysis = async (): Promise<void> => {
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
      setDownloadProgress(null);
    } catch (err) {
      setError(String(err));
    }
  };

  const downloadPercent =
    downloadProgress === null ? null : Math.min(100, Math.max(0, Math.round(downloadProgress.percent)));

  return (
    <section className="panel">
      <h3>Interview Analyzer</h3>
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
            placeholder="user123\tJohn Doe\t9999999999\tTR1\t1gfZvlSq...\tJOB01\tMyCompany\t2026-02-13\t0\t300"
          />
          <button className="secondary-button" onClick={handleParsePaste}>
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
      <ValidationPanel report={validationReport} fileName="interview_preflight_issues.csv" />

      <div className="button-row">
        <button
          className="primary-button"
          disabled={loading || rows.length === 0 || (validationReport?.summary.errors ?? 0) > 0}
          onClick={startAnalysis}
        >
          {loading ? "Running Interview Analysis..." : "Start Analysis Pipeline"}
        </button>
        {loading && (
          <button className="danger-button" onClick={() => void stopAnalysis()}>
            Stop
          </button>
        )}
      </div>
      {(loading || liveStatus) && (
        <div className={`live-status-line ${downloadPercent !== null ? "with-progress" : ""}`}>
          <span className="live-status-text">{liveStatus || "Starting..."}</span>
          {downloadPercent !== null && (
            <div className="live-status-progress-inline">
              <div className="live-progress-track">
                <div className="live-progress-fill" style={{ width: `${downloadPercent}%` }} />
              </div>
              <span className="live-progress-percent">{downloadPercent}%</span>
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
            onClick={() => downloadCsv("interview_analysis.csv", rowsToCsv(result.rows))}
          >
            Download CSV
          </button>
          <ResultTable rows={result.rows} />
        </>
      )}
    </section>
  );
}

function VideoUploaderModule({ product, provider }: { product: string; provider: AiProvider }) {
  const [metadataInputMethod, setMetadataInputMethod] = useState<"Paste Text" | "Upload CSV">("Paste Text");
  const [metadataPaste, setMetadataPaste] = useState("");
  const [metadata, setMetadata] = useState<VideoUploaderMetadata | null>(null);
  const [metadataValidation, setMetadataValidation] = useState<ValidationReport<VideoUploaderMetadata> | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ApiResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveStatus, setLiveStatus] = useState("");
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const pollAbortRef = useRef<AbortController | null>(null);

  const parseMetadata = (): void => {
    const parsed = parseVideoMetadataFromPaste(metadataPaste);
    const report = parsed ? validateVideoUploaderMetadata(parsed) : null;
    setMetadata(parsed);
    setMetadataValidation(report);
    setResult(null);
    if (!parsed) {
      setError("Metadata must be a single tab-separated row with 8, 9, or 10 columns.");
      return;
    }

    setError(report && report.summary.errors > 0 ? "Fix metadata validation errors before starting." : null);
  };

  const handleMetadataCsvUpload = async (csvFile: File): Promise<void> => {
    const text = await csvFile.text();
    const parsedCsvRows = parseCsvRows(text);
    const parsedMetadata = parseVideoMetadataFromCsvRows(parsedCsvRows);

    if (!parsedMetadata || !parsedMetadata.interview_date) {
      setMetadata(null);
      setMetadataValidation(null);
      setResult(null);
      setError("CSV metadata must include interview_date in the first row.");
      return;
    }

    const report = validateVideoUploaderMetadata(parsedMetadata);
    setMetadata(parsedMetadata);
    setMetadataValidation(report);
    setResult(null);
    setError(report.summary.errors > 0 ? "Fix metadata validation errors before starting." : null);
  };

  const startUploadAnalysis = async (): Promise<void> => {
    if (!metadata || !file) {
      setError("Provide metadata (paste or CSV) and upload one video file.");
      return;
    }
    if (!metadata.interview_date.trim()) {
      setError("Metadata must include interview_date.");
      return;
    }
    const report = metadataValidation ?? validateVideoUploaderMetadata(metadata);
    if (!metadataValidation) {
      setMetadataValidation(report);
    }
    if (report.summary.errors > 0) {
      setError("Metadata pre-flight validation has errors. Please fix them before starting.");
      return;
    }

    void requestDesktopNotificationPermission();
    const pollController = new AbortController();
    pollAbortRef.current = pollController;

    try {
      setLoading(true);
      setError(null);
      setResult(null);
      setLiveStatus("Submitting local video job...");
      const started = await startVideoUploaderJob({ metadata, file, product, provider });
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
        jobName: "Video Uploader",
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
      void notifyJobFailed({ jobName: "Video Uploader", errorMessage: String(err) });
      setError(String(err));
    } finally {
      setLoading(false);
      setActiveJobId(null);
      pollAbortRef.current = null;
    }
  };

  const stopUploadAnalysis = async (): Promise<void> => {
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
    <section className="panel">
      <h3>Video Uploader</h3>

      <div className="inline-controls">
        <label>
          <input
            type="radio"
            checked={metadataInputMethod === "Paste Text"}
            onChange={() => setMetadataInputMethod("Paste Text")}
          />
          Paste Text
        </label>
        <label>
          <input
            type="radio"
            checked={metadataInputMethod === "Upload CSV"}
            onChange={() => setMetadataInputMethod("Upload CSV")}
          />
          Upload CSV
        </label>
      </div>

      {metadataInputMethod === "Paste Text" ? (
        <>
          <textarea
            className="textarea"
            value={metadataPaste}
            onChange={(event) => setMetadataPaste(event.target.value)}
            placeholder="user123\tJohn Doe\t9999999999\tTR1\tDriveIdOptional\tJOB01\tMyCompany\t2026-02-13\t0\t300"
          />
          <button className="secondary-button" onClick={parseMetadata}>
            Parse Metadata
          </button>
        </>
      ) : (
        <label className="file-input">
          Upload Metadata CSV
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => {
              const csvFile = event.target.files?.[0];
              if (csvFile) {
                void handleMetadataCsvUpload(csvFile);
              }
            }}
          />
        </label>
      )}

      <label className="file-input">
        Upload Video
        <input
          type="file"
          accept="video/mp4,video/mov,video/avi,video/mkv,video/webm"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
      </label>

      <div className="muted">Metadata: {metadata ? "Ready" : "Not parsed"} | File: {file?.name ?? "None"}</div>
      <ValidationPanel report={metadataValidation} fileName="video_uploader_preflight_issues.csv" />

      <div className="button-row">
        <button
          className="primary-button"
          disabled={loading || !metadata || !file || (metadataValidation?.summary.errors ?? 0) > 0}
          onClick={startUploadAnalysis}
        >
          {loading ? "Processing Local Video..." : "Start Local Processing"}
        </button>
        {loading && (
          <button className="danger-button" onClick={() => void stopUploadAnalysis()}>
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
            onClick={() => downloadCsv("video_uploader_analysis.csv", rowsToCsv(result.rows))}
          >
            Download CSV
          </button>
          <ResultTable rows={result.rows} />
        </>
      )}
    </section>
  );
}

export function InterviewPage({
  product,
  modules,
  selectedModule,
  onModuleChange,
  provider,
  onProviderChange,
}: InterviewPageProps) {
  const moduleOptions = modules.length > 0 ? modules : defaultModules;
  const resolvedSelectedModule = moduleOptions.includes(selectedModule)
    ? selectedModule
    : moduleOptions[0];

  return (
    <div className="page-section">
      <div className="field-two-col-row">
        <label className="field-row-stacked" htmlFor="interview-module">
          Select
          <select
            id="interview-module"
            value={resolvedSelectedModule}
            onChange={(event) => onModuleChange(event.target.value)}
          >
            {moduleOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label className="field-row-stacked" htmlFor="interview-provider">
          API
          <select
            id="interview-provider"
            value={provider}
            onChange={(event) => onProviderChange(event.target.value as AiProvider)}
          >
            <option value="mistral">Mistral API</option>
            <option value="openai">OpenAI API</option>
          </select>
        </label>
      </div>

      {resolvedSelectedModule === "Video_uploader" ? (
        <VideoUploaderModule product={product} provider={provider} />
      ) : (
        <InterviewAnalyzerModule product={product} provider={provider} />
      )}
    </div>
  );
}
