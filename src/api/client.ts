import type {
  AiProvider,
  ApiResult,
  AppConfig,
  AssignmentInputRow,
  AssessmentIndividualRow,
  ProviderSettings,
  AssessmentZipRow,
  InterviewInputRow,
  JobStatusResponse,
  StartJobResponse,
  VideoUploaderMetadata,
} from "../types";

const normalizeApiBase = (value: string): string => value.replace(/\/+$/, "");

const resolveApiBase = (): string => {
  const configured = process.env.REACT_APP_API_URL?.trim();
  if (configured) {
    return normalizeApiBase(configured);
  }

  if (typeof window !== "undefined") {
    const host = window.location.hostname;
    if (host === "localhost" || host === "127.0.0.1") {
      return "http://localhost:4000/api";
    }
  }

  return "/api";
};

const API_BASE = resolveApiBase();
const DEFAULT_TIMEOUT_MS = 60_000;
const CONFIG_TIMEOUT_MS = 10_000;
const JOB_STATUS_TIMEOUT_MS = 20_000;
const JOB_CONTROL_TIMEOUT_MS = 20_000;
const START_REQUEST_TIMEOUT_MS = 300_000;

const toApiUrl = (path: string): string => `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;

const fetchWithTimeout = async (
  url: string,
  init?: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

const assertResponse = async (response: Response, url: string): Promise<Response> => {
  if (!response.ok) {
    const text = await response.text();
    if (response.status === 413) {
      throw new Error(
        `Payload too large for ${url}. Reduce input size or increase upload limits (Nginx client_max_body_size / backend API_BODY_LIMIT).`,
      );
    }
    throw new Error(
      text || `API request failed (${response.status} ${response.statusText}) for ${url}`,
    );
  }
  return response;
};

const parseJson = async <T>(response: Response, url: string): Promise<T> => {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    const preview = (await response.text()).slice(0, 160);
    throw new Error(
      `Expected JSON from API but received "${contentType || "unknown"}" for ${url}. Response starts with: ${preview}`,
    );
  }

  return response.json() as Promise<T>;
};

const postJson = async <T>(
  path: string,
  payload: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> => {
  const url = toApiUrl(path);
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  }, timeoutMs);

  await assertResponse(response, url);
  return parseJson<T>(response, url);
};

export const fetchAppConfig = async (): Promise<AppConfig> => {
  const url = toApiUrl("/app-config");
  const response = await fetchWithTimeout(url, undefined, CONFIG_TIMEOUT_MS);
  await assertResponse(response, url);
  return parseJson<AppConfig>(response, url);
};

export const fetchProviderSettings = async (): Promise<ProviderSettings> => {
  const url = toApiUrl("/settings/provider-config");
  const response = await fetchWithTimeout(url, undefined, CONFIG_TIMEOUT_MS);
  await assertResponse(response, url);
  return parseJson<ProviderSettings>(response, url);
};

export const saveProviderSettings = async (settings: ProviderSettings): Promise<ProviderSettings> => {
  const url = toApiUrl("/settings/provider-config");
  const response = await fetchWithTimeout(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(settings),
  }, CONFIG_TIMEOUT_MS);
  await assertResponse(response, url);
  return parseJson<ProviderSettings>(response, url);
};

export const fetchJobStatus = async (jobId: string): Promise<JobStatusResponse> => {
  const url = toApiUrl(`/jobs/${jobId}`);
  const response = await fetchWithTimeout(url, undefined, JOB_STATUS_TIMEOUT_MS);
  await assertResponse(response, url);
  return parseJson<JobStatusResponse>(response, url);
};

export const cancelJob = async (jobId: string): Promise<JobStatusResponse> => {
  const url = toApiUrl(`/jobs/${jobId}/cancel`);
  const response = await fetchWithTimeout(url, {
    method: "POST",
  }, JOB_CONTROL_TIMEOUT_MS);
  await assertResponse(response, url);
  return parseJson<JobStatusResponse>(response, url);
};

export const analyzeInterviewRows = (
  rows: InterviewInputRow[],
  product: string,
  provider: AiProvider,
): Promise<ApiResult> => {
  return postJson<ApiResult>("/interview/analyzer", { rows, product, provider });
};

export const startInterviewAnalyzerJob = (
  rows: InterviewInputRow[],
  product: string,
  provider: AiProvider,
): Promise<StartJobResponse> => {
  return postJson<StartJobResponse>(
    "/interview/analyzer/start",
    { rows, product, provider },
    START_REQUEST_TIMEOUT_MS,
  );
};

export const analyzeVideoUploader = async (args: {
  metadata: VideoUploaderMetadata;
  file: File;
  product: string;
  provider: AiProvider;
}): Promise<ApiResult> => {
  const formData = new FormData();
  formData.append("metadata", JSON.stringify(args.metadata));
  formData.append("product", args.product);
  formData.append("provider", args.provider);
  formData.append("video", args.file);

  const url = toApiUrl("/interview/video-uploader");
  const response = await fetchWithTimeout(url, {
    method: "POST",
    body: formData,
  });

  await assertResponse(response, url);
  return parseJson<ApiResult>(response, url);
};

export const startVideoUploaderJob = async (args: {
  metadata: VideoUploaderMetadata;
  file: File;
  product: string;
  provider: AiProvider;
}): Promise<StartJobResponse> => {
  const formData = new FormData();
  formData.append("metadata", JSON.stringify(args.metadata));
  formData.append("product", args.product);
  formData.append("provider", args.provider);
  formData.append("video", args.file);

  const url = toApiUrl("/interview/video-uploader/start");
  const response = await fetchWithTimeout(url, {
    method: "POST",
    body: formData,
  }, START_REQUEST_TIMEOUT_MS);

  await assertResponse(response, url);
  return parseJson<StartJobResponse>(response, url);
};

export const analyzeDrilldownRows = (
  rows: Array<Record<string, string>>,
  product: string,
  provider: AiProvider,
): Promise<ApiResult> => {
  return postJson<ApiResult>("/drilldown/analyze", { rows, product, provider });
};

export const startDrilldownJob = (
  rows: Array<Record<string, string>>,
  product: string,
  provider: AiProvider,
): Promise<StartJobResponse> => {
  return postJson<StartJobResponse>(
    "/drilldown/analyze/start",
    { rows, product, provider },
    START_REQUEST_TIMEOUT_MS,
  );
};

export const analyzeAssignmentsRows = (
  rows: AssignmentInputRow[],
  product: string,
  provider: AiProvider,
): Promise<ApiResult> => {
  return postJson<ApiResult>("/assignments/analyze", { rows, product, provider });
};

export const startAssignmentsJob = (
  rows: AssignmentInputRow[],
  product: string,
  provider: AiProvider,
): Promise<StartJobResponse> => {
  return postJson<StartJobResponse>(
    "/assignments/analyze/start",
    { rows, product, provider },
    START_REQUEST_TIMEOUT_MS,
  );
};

export const analyzeAssessmentsZip = async (
  rows: AssessmentZipRow[],
  product: string,
  provider: AiProvider,
): Promise<ApiResult> => {
  const formData = new FormData();
  formData.append("product", product);
  formData.append("provider", provider);

  const normalizedRows = rows
    .filter((row) => row.file)
    .map((row) => ({
      fileField: row.fileField,
      company_name: row.company_name,
      job_id: row.job_id,
      assessment_date: row.assessment_date,
    }));

  formData.append("rows", JSON.stringify(normalizedRows));

  for (const row of rows) {
    if (row.file) {
      formData.append(row.fileField, row.file);
    }
  }

  const url = toApiUrl("/assessments/zip");
  const response = await fetchWithTimeout(url, {
    method: "POST",
    body: formData,
  });

  await assertResponse(response, url);
  return parseJson<ApiResult>(response, url);
};

export const startAssessmentsZipJob = async (
  rows: AssessmentZipRow[],
  product: string,
  provider: AiProvider,
): Promise<StartJobResponse> => {
  const formData = new FormData();
  formData.append("product", product);
  formData.append("provider", provider);

  const normalizedRows = rows
    .filter((row) => row.file)
    .map((row) => ({
      fileField: row.fileField,
      company_name: row.company_name,
      job_id: row.job_id,
      assessment_date: row.assessment_date,
    }));

  formData.append("rows", JSON.stringify(normalizedRows));

  for (const row of rows) {
    if (row.file) {
      formData.append(row.fileField, row.file);
    }
  }

  const url = toApiUrl("/assessments/zip/start");
  const response = await fetchWithTimeout(url, {
    method: "POST",
    body: formData,
  }, START_REQUEST_TIMEOUT_MS);

  await assertResponse(response, url);
  return parseJson<StartJobResponse>(response, url);
};

export const analyzeAssessmentsIndividual = async (
  rows: AssessmentIndividualRow[],
  product: string,
  provider: AiProvider,
): Promise<ApiResult> => {
  const formData = new FormData();
  formData.append("product", product);
  formData.append("provider", provider);

  const normalizedRows = rows
    .filter((row) => row.file)
    .map((row) => ({
      fileField: row.fileField,
      company_name: row.company_name,
      job_id: row.job_id,
      assessment_date: row.assessment_date,
    }));

  formData.append("rows", JSON.stringify(normalizedRows));

  for (const row of rows) {
    if (row.file) {
      formData.append(row.fileField, row.file);
    }
  }

  const url = toApiUrl("/assessments/individual");
  const response = await fetchWithTimeout(url, {
    method: "POST",
    body: formData,
  });

  await assertResponse(response, url);
  return parseJson<ApiResult>(response, url);
};

export const startAssessmentsIndividualJob = async (
  rows: AssessmentIndividualRow[],
  product: string,
  provider: AiProvider,
): Promise<StartJobResponse> => {
  const formData = new FormData();
  formData.append("product", product);
  formData.append("provider", provider);

  const normalizedRows = rows
    .filter((row) => row.file)
    .map((row) => ({
      fileField: row.fileField,
      company_name: row.company_name,
      job_id: row.job_id,
      assessment_date: row.assessment_date,
    }));

  formData.append("rows", JSON.stringify(normalizedRows));

  for (const row of rows) {
    if (row.file) {
      formData.append(row.fileField, row.file);
    }
  }

  const url = toApiUrl("/assessments/individual/start");
  const response = await fetchWithTimeout(url, {
    method: "POST",
    body: formData,
  }, START_REQUEST_TIMEOUT_MS);

  await assertResponse(response, url);
  return parseJson<StartJobResponse>(response, url);
};

export const getDrilldownSampleTemplateUrl = (): string => {
  return `${API_BASE}/drilldown/sample-template`;
};
