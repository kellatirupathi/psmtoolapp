export type AppConfig = {
  appName: string;
  version: string;
  productOptions: string[];
  pages: string[];
  interviewModules: string[];
  desktopDownloadUrl?: string;
};

export type BigQueryTableSummary = {
  tableName: string;
  rowCount: string;
  sizeBytes: string;
  lastModifiedTime: string;
};

export type BigQueryTableListResponse = {
  projectId: string;
  datasetId: string;
  tables: BigQueryTableSummary[];
};

export type BigQueryTablePreviewResponse = {
  projectId: string;
  datasetId: string;
  tableName: string;
  headers: string[];
  rows: Array<Record<string, string>>;
  totalRows: string;
  pageToken: string;
  limit: number;
};

export type AiProvider = "mistral" | "openai";

export type ProviderSettingsEntry = {
  apiKey: string;
  apiKey2: string;
  apiKey3: string;
  apiKey4: string;
  transcribeApiKey: string;
  chatEndpoint: string;
  ocrEndpoint: string;
  transcribeEndpoint: string;
  chatModel: string;
  ocrModel: string;
  transcribeModel: string;
};

export type ProviderSettings = {
  mistral: ProviderSettingsEntry;
  openai: ProviderSettingsEntry;
  saveToSheets: boolean;
  saveToBigQuery: boolean;
  updatedAt: string;
};

export type ApiResult = {
  rows: Array<Record<string, string>>;
  savedToSheet: boolean;
  savedToBigQuery?: boolean;
};

export type JobState = "queued" | "running" | "success" | "error" | "cancelled";

export type JobProgress = {
  percent: number;
  loadedBytes?: number;
  totalBytes?: number;
};

export type StartJobResponse = {
  jobId: string;
};

export type JobStatusResponse = {
  id: string;
  state: JobState;
  message: string;
  result?: ApiResult;
  partialResult?: ApiResult;
  progress?: JobProgress;
  error?: string;
  cancelRequested?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type InterviewInputRow = {
  user_id: string;
  fullName: string;
  MobileNumber: string;
  interview_round: string;
  drive_file_id: string;
  job_id: string;
  company_name: string;
  interview_date: string;
  clip_start_time?: string | number | null;
  clip_end_time?: string | number | null;
};

export type AssignmentInputRow = {
  job_id: string;
  company_name: string;
  assignment_link: string;
  assignment_date: string;
};

export type AssessmentZipRow = {
  fileField: string;
  company_name: string;
  job_id: string;
  assessment_date: string;
  file?: File;
};

export type AssessmentIndividualRow = {
  fileField: string;
  company_name: string;
  job_id: string;
  assessment_date: string;
  file?: File;
};

export type VideoUploaderMetadata = {
  user_id: string;
  fullName: string;
  MobileNumber: string;
  interview_round: string;
  drive_file_id?: string;
  job_id: string;
  company_name: string;
  interview_date: string;
  clip_start_time?: string | number | null;
  clip_end_time?: string | number | null;
};
