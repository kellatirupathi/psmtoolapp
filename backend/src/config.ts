import fs from "node:fs";
import path from "node:path";

export const PRODUCT_OPTIONS = [
  "Intensive",
  "Academy",
  "External",
  "Academy Edge",
  "Nxtwave Edge",
  "NIAT",
  "Intensive Offline",
  "Experienced Hiring",
] as const;

export const GSHEET_ID = process.env.GSHEET_ID ?? "1HgOg9AS2fJ5UIyvkg3eJlaIm38MSunoW-bcOcagYc1c";

export const SHEET_NAMES = {
  interview: "interview_Q&A",
  drilldown: "Drill_Q&A",
  assessments: "Assess_Q&A",
  assignments: "Assign_Q&A",
} as const;

export const BIGQUERY_PROJECT_ID = process.env.BIGQUERY_PROJECT_ID ?? process.env.GCP_PROJECT_ID ?? "";
export const BIGQUERY_DATASET_ID = process.env.BIGQUERY_DATASET_ID ?? process.env.DATASET_ID ?? "";

export const BIGQUERY_TABLE_NAMES = {
  interview: process.env.BIGQUERY_TABLE_INTERVIEW ?? "interviews_analyzer_questions_from_psm_team",
  drilldown: process.env.BIGQUERY_TABLE_DRILLDOWN ?? "drill_down_questions_from_psm_team",
  assessments: process.env.BIGQUERY_TABLE_ASSESSMENTS ?? "assessment_questions_from_psm_team",
  assignments: process.env.BIGQUERY_TABLE_ASSIGNMENTS ?? "assignment_questions_from_psm_team",
} as const;

const parseNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const MISTRAL_CHAT_MIN_INTERVAL_SECONDS = parseNumber(
  process.env.MISTRAL_CHAT_MIN_INTERVAL_SECONDS,
  1.2,
);

export const MISTRAL_CHAT_MAX_RETRIES_PER_KEY = parseNumber(
  process.env.MISTRAL_CHAT_MAX_RETRIES_PER_KEY,
  4,
);

export const QNA_CHUNK_SIZE = parseNumber(process.env.QNA_CHUNK_SIZE, 18000);
export const QNA_CHUNK_OVERLAP = parseNumber(process.env.QNA_CHUNK_OVERLAP, 1200);

export const APP_BASE_DIR = path.resolve(process.env.APP_BASE_DIR?.trim() || process.cwd());

export const APP_DIRS = {
  downloadedVideos: path.join(APP_BASE_DIR, "DownloadedVideos"),
  generatedTranscripts: path.join(APP_BASE_DIR, "GeneratedTranscripts"),
  qa: path.join(APP_BASE_DIR, "Q&A"),
  audioChunks: path.join(APP_BASE_DIR, "AudioChunks"),
} as const;

export const DESKTOP_DOWNLOAD_URL = (process.env.DESKTOP_DOWNLOAD_URL ?? "").trim();

export type ServiceAccountCredentials = {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  auth_uri: string;
  token_uri: string;
  auth_provider_x509_cert_url: string;
  client_x509_cert_url: string;
  universe_domain?: string;
};

const getFirstEnv = (keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined && value !== "") {
      return value;
    }
  }
  return undefined;
};

const normalizePrivateKey = (value: string | undefined): string | undefined => {
  if (!value) return value;
  return value.replace(/\\n/g, "\n");
};

const REQUIRED_SERVICE_ACCOUNT_FIELDS: Array<keyof ServiceAccountCredentials> = [
  "type",
  "project_id",
  "private_key_id",
  "private_key",
  "client_email",
  "client_id",
  "auth_uri",
  "token_uri",
  "auth_provider_x509_cert_url",
  "client_x509_cert_url",
];

const isCompleteServiceAccount = (creds: ServiceAccountCredentials): boolean => {
  return REQUIRED_SERVICE_ACCOUNT_FIELDS.every((field) => {
    const value = creds[field];
    return typeof value === "string" && value.trim().length > 0;
  });
};

type InlineServiceAccountKeyMap = {
  type: string[];
  project_id: string[];
  private_key_id: string[];
  private_key: string[];
  client_email: string[];
  client_id: string[];
  auth_uri: string[];
  token_uri: string[];
  auth_provider_x509_cert_url: string[];
  client_x509_cert_url: string[];
  universe_domain: string[];
};

const DEFAULT_INLINE_SERVICE_ACCOUNT_KEY_MAP: InlineServiceAccountKeyMap = {
  type: ["GCP_TYPE", "type"],
  project_id: ["GCP_PROJECT_ID", "project_id"],
  private_key_id: ["GCP_PRIVATE_KEY_ID", "private_key_id"],
  private_key: ["GCP_PRIVATE_KEY", "private_key"],
  client_email: ["GCP_CLIENT_EMAIL", "client_email"],
  client_id: ["GCP_CLIENT_ID", "client_id"],
  auth_uri: ["GCP_AUTH_URI", "auth_uri"],
  token_uri: ["GCP_TOKEN_URI", "token_uri"],
  auth_provider_x509_cert_url: ["GCP_AUTH_PROVIDER_X509_CERT_URL", "auth_provider_x509_cert_url"],
  client_x509_cert_url: ["GCP_CLIENT_X509_CERT_URL", "client_x509_cert_url"],
  universe_domain: ["GCP_UNIVERSE_DOMAIN", "universe_domain"],
};

const SHEETS_INLINE_SERVICE_ACCOUNT_KEY_MAP: InlineServiceAccountKeyMap = {
  type: ["GCP_SHEETS_TYPE", "SHEETS_TYPE", ...DEFAULT_INLINE_SERVICE_ACCOUNT_KEY_MAP.type],
  project_id: ["GCP_SHEETS_PROJECT_ID", "SHEETS_PROJECT_ID", ...DEFAULT_INLINE_SERVICE_ACCOUNT_KEY_MAP.project_id],
  private_key_id: [
    "GCP_SHEETS_PRIVATE_KEY_ID",
    "SHEETS_PRIVATE_KEY_ID",
    ...DEFAULT_INLINE_SERVICE_ACCOUNT_KEY_MAP.private_key_id,
  ],
  private_key: ["GCP_SHEETS_PRIVATE_KEY", "SHEETS_PRIVATE_KEY", ...DEFAULT_INLINE_SERVICE_ACCOUNT_KEY_MAP.private_key],
  client_email: [
    "GCP_SHEETS_CLIENT_EMAIL",
    "SHEETS_CLIENT_EMAIL",
    ...DEFAULT_INLINE_SERVICE_ACCOUNT_KEY_MAP.client_email,
  ],
  client_id: ["GCP_SHEETS_CLIENT_ID", "SHEETS_CLIENT_ID", ...DEFAULT_INLINE_SERVICE_ACCOUNT_KEY_MAP.client_id],
  auth_uri: ["GCP_SHEETS_AUTH_URI", "SHEETS_AUTH_URI", ...DEFAULT_INLINE_SERVICE_ACCOUNT_KEY_MAP.auth_uri],
  token_uri: ["GCP_SHEETS_TOKEN_URI", "SHEETS_TOKEN_URI", ...DEFAULT_INLINE_SERVICE_ACCOUNT_KEY_MAP.token_uri],
  auth_provider_x509_cert_url: [
    "GCP_SHEETS_AUTH_PROVIDER_X509_CERT_URL",
    "SHEETS_AUTH_PROVIDER_X509_CERT_URL",
    ...DEFAULT_INLINE_SERVICE_ACCOUNT_KEY_MAP.auth_provider_x509_cert_url,
  ],
  client_x509_cert_url: [
    "GCP_SHEETS_CLIENT_X509_CERT_URL",
    "SHEETS_CLIENT_X509_CERT_URL",
    ...DEFAULT_INLINE_SERVICE_ACCOUNT_KEY_MAP.client_x509_cert_url,
  ],
  universe_domain: ["GCP_SHEETS_UNIVERSE_DOMAIN", "SHEETS_UNIVERSE_DOMAIN", ...DEFAULT_INLINE_SERVICE_ACCOUNT_KEY_MAP.universe_domain],
};

const toServiceAccountCredentials = (value: unknown): ServiceAccountCredentials | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const source = value as Record<string, unknown>;
  const creds: ServiceAccountCredentials = {
    type: String(source.type ?? "").trim(),
    project_id: String(source.project_id ?? "").trim(),
    private_key_id: String(source.private_key_id ?? "").trim(),
    private_key: normalizePrivateKey(String(source.private_key ?? "").trim()) ?? "",
    client_email: String(source.client_email ?? "").trim(),
    client_id: String(source.client_id ?? "").trim(),
    auth_uri: String(source.auth_uri ?? "").trim(),
    token_uri: String(source.token_uri ?? "").trim(),
    auth_provider_x509_cert_url: String(source.auth_provider_x509_cert_url ?? "").trim(),
    client_x509_cert_url: String(source.client_x509_cert_url ?? "").trim(),
    universe_domain:
      source.universe_domain === undefined ? undefined : String(source.universe_domain).trim(),
  };

  return isCompleteServiceAccount(creds) ? creds : null;
};

const getInlineServiceAccountFromEnv = (
  keyMap: InlineServiceAccountKeyMap = DEFAULT_INLINE_SERVICE_ACCOUNT_KEY_MAP,
): ServiceAccountCredentials | null => {
  const creds: ServiceAccountCredentials = {
    type: getFirstEnv(keyMap.type) ?? "",
    project_id: getFirstEnv(keyMap.project_id) ?? "",
    private_key_id: getFirstEnv(keyMap.private_key_id) ?? "",
    private_key: normalizePrivateKey(getFirstEnv(keyMap.private_key)) ?? "",
    client_email: getFirstEnv(keyMap.client_email) ?? "",
    client_id: getFirstEnv(keyMap.client_id) ?? "",
    auth_uri: getFirstEnv(keyMap.auth_uri) ?? "",
    token_uri: getFirstEnv(keyMap.token_uri) ?? "",
    auth_provider_x509_cert_url: getFirstEnv(keyMap.auth_provider_x509_cert_url) ?? "",
    client_x509_cert_url: getFirstEnv(keyMap.client_x509_cert_url) ?? "",
    universe_domain: getFirstEnv(keyMap.universe_domain),
  };

  return isCompleteServiceAccount(creds) ? creds : null;
};

const getServiceAccountFromJsonEnv = (envKey: string): ServiceAccountCredentials | null => {
  const json = process.env[envKey];
  if (!json) {
    return null;
  }

  try {
    return toServiceAccountCredentials(JSON.parse(json));
  } catch {
    return null;
  }
};

const getServiceAccountFromFileEnv = (envKey: string): ServiceAccountCredentials | null => {
  const filePath = process.env[envKey];
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }

  try {
    const data = fs.readFileSync(filePath, "utf8");
    return toServiceAccountCredentials(JSON.parse(data));
  } catch {
    return null;
  }
};

export const getServiceAccountCredentials = (): ServiceAccountCredentials | null => {
  return (
    getServiceAccountFromJsonEnv("GCP_SERVICE_ACCOUNT_JSON") ??
    getServiceAccountFromFileEnv("GCP_SERVICE_ACCOUNT_FILE") ??
    getInlineServiceAccountFromEnv()
  );
};

export const getSheetsServiceAccountCredentials = (): ServiceAccountCredentials | null => {
  return (
    getServiceAccountFromJsonEnv("GCP_SHEETS_SERVICE_ACCOUNT_JSON") ??
    getServiceAccountFromFileEnv("GCP_SHEETS_SERVICE_ACCOUNT_FILE") ??
    getInlineServiceAccountFromEnv(SHEETS_INLINE_SERVICE_ACCOUNT_KEY_MAP) ??
    getServiceAccountCredentials()
  );
};

export const getBigQueryServiceAccountCredentials = (): ServiceAccountCredentials | null => {
  return (
    getServiceAccountFromJsonEnv("GCP_BIGQUERY_SERVICE_ACCOUNT_JSON") ??
    getServiceAccountFromFileEnv("GCP_BIGQUERY_SERVICE_ACCOUNT_FILE") ??
    getServiceAccountCredentials()
  );
};

export const getMistralChatKeys = (): string[] => {
  const keys = [
    process.env.MISTRAL_API_KEY_1,
    process.env.MISTRAL_API_KEY_2,
    process.env.MISTRAL_API_KEY_3,
    process.env.MISTRAL_API_KEY_4,
    process.env.MISTRAL_API_KEY,
  ].filter((value): value is string => Boolean(value));

  return keys;
};

export const getMistralTranscribeKey = (): string | null => {
  return process.env.MISTRAL_TRANSCRIBE_API_KEY ?? process.env.MISTRAL_API_KEY ?? null;
};

export const GITHUB_GIST_TOKEN = process.env.GITHUB_GIST_TOKEN ?? null;

export const MISTRAL_URLS = {
  chat: "https://api.mistral.ai/v1/chat/completions",
  ocr: "https://api.mistral.ai/v1/ocr",
  transcribe: "https://api.mistral.ai/v1/audio/transcriptions",
} as const;

export const MISTRAL_MODELS = {
  chat: "mistral-large-latest",
  ocr: "mistral-ocr-latest",
  transcribe: "voxtral-mini-latest",
} as const;
