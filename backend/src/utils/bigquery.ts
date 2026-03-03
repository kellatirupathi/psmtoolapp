import { randomUUID } from "node:crypto";
import { google } from "googleapis";
import { BIGQUERY_DATASET_ID, BIGQUERY_PROJECT_ID, getBigQueryServiceAccountCredentials } from "../config";
import { logError } from "./logger";

const DEFAULT_BIGQUERY_SCOPES = [
  "https://www.googleapis.com/auth/bigquery",
  "https://www.googleapis.com/auth/bigquery.insertdata",
];
const DEFAULT_PREVIEW_LIMIT = 50;
const MAX_PREVIEW_LIMIT = 500;

type BigQueryRowValue = string | number | boolean | null;
type BigQueryRowJson = Record<string, BigQueryRowValue>;
type BigQuerySchemaField = { name: string; type: "STRING"; mode: "NULLABLE" };

const normalizeRowValue = (value: unknown): BigQueryRowValue => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value) || typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
};

const normalizeRows = (rows: Record<string, unknown>[]): BigQueryRowJson[] => {
  return rows.map((row) => {
    const normalized: BigQueryRowJson = {};
    for (const [key, value] of Object.entries(row)) {
      normalized[key] = normalizeRowValue(value);
    }
    return normalized;
  });
};

const getSchemaFromRows = (rows: Record<string, unknown>[]): BigQuerySchemaField[] => {
  const orderedKeys: string[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue;
      seen.add(key);
      orderedKeys.push(key);
    }
  }

  return orderedKeys.map((name) => ({
    name,
    type: "STRING",
    mode: "NULLABLE",
  }));
};

const getBigQueryApi = () => {
  const credentials = getBigQueryServiceAccountCredentials();
  if (!credentials) {
    return null;
  }

  const projectId = BIGQUERY_PROJECT_ID || credentials.project_id;
  if (!projectId) {
    return null;
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: DEFAULT_BIGQUERY_SCOPES,
  });

  return {
    client: google.bigquery({ version: "v2", auth }),
    projectId,
  };
};

const resolveDatasetId = (datasetId: string | undefined): string | null => {
  const normalized = String(datasetId ?? BIGQUERY_DATASET_ID ?? "").trim();
  return normalized.length > 0 ? normalized : null;
};

const toErrorCode = (error: unknown): number | null => {
  if (!error || typeof error !== "object") return null;
  if ("code" in error && typeof (error as { code?: unknown }).code === "number") {
    return (error as { code: number }).code;
  }
  const response = (error as { response?: { status?: unknown } }).response;
  if (response && typeof response.status === "number") {
    return response.status;
  }
  return null;
};

const isNotFoundError = (error: unknown): boolean => {
  const code = toErrorCode(error);
  if (code === 404) return true;
  return String(error).toLowerCase().includes("not found");
};

const ensureTableExists = async (args: {
  client: ReturnType<typeof google.bigquery>;
  projectId: string;
  datasetId: string;
  tableName: string;
  rows: Record<string, unknown>[];
}): Promise<boolean> => {
  try {
    await args.client.tables.get({
      projectId: args.projectId,
      datasetId: args.datasetId,
      tableId: args.tableName,
    });
    return true;
  } catch (error) {
    if (!isNotFoundError(error)) {
      logError(`Failed to verify BigQuery table ${args.datasetId}.${args.tableName}`, String(error));
      return false;
    }
  }

  const fields = getSchemaFromRows(args.rows);
  if (fields.length === 0) {
    logError(`Cannot create BigQuery table ${args.datasetId}.${args.tableName}: no columns inferred.`);
    return false;
  }

  try {
    await args.client.tables.insert({
      projectId: args.projectId,
      datasetId: args.datasetId,
      requestBody: {
        tableReference: {
          projectId: args.projectId,
          datasetId: args.datasetId,
          tableId: args.tableName,
        },
        schema: {
          fields,
        },
      },
    });
    return true;
  } catch (error) {
    logError(`Failed to create BigQuery table ${args.datasetId}.${args.tableName}`, String(error));
    return false;
  }
};

const toSafePreviewLimit = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_PREVIEW_LIMIT;
  }

  return Math.min(Math.round(parsed), MAX_PREVIEW_LIMIT);
};

const toText = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const getFieldNamesFromSchema = (schema: unknown): string[] => {
  if (!schema || typeof schema !== "object") {
    return [];
  }

  const fields = (schema as { fields?: Array<{ name?: unknown }> }).fields;
  if (!Array.isArray(fields)) {
    return [];
  }

  return fields
    .map((field) => String(field?.name ?? "").trim())
    .filter((name) => name.length > 0);
};

const normalizePreviewRows = (
  rows: unknown,
  headers: string[],
): Array<Record<string, string>> => {
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows.map((rawRow) => {
    const normalized: Record<string, string> = {};
    const cells = Array.isArray((rawRow as { f?: unknown }).f)
      ? ((rawRow as { f: Array<{ v?: unknown }> }).f)
      : [];

    headers.forEach((header, index) => {
      const rawCell = cells[index];
      const value = rawCell && typeof rawCell === "object" && "v" in rawCell
        ? (rawCell as { v?: unknown }).v
        : null;
      normalized[header] = toText(value);
    });

    return normalized;
  });
};

export type BigQueryTableSummary = {
  tableName: string;
  rowCount: string;
  sizeBytes: string;
  lastModifiedTime: string;
};

export const listBigQueryTables = async (datasetId?: string): Promise<{
  projectId: string;
  datasetId: string;
  tables: BigQueryTableSummary[];
} | null> => {
  const resolvedDatasetId = resolveDatasetId(datasetId);
  if (!resolvedDatasetId) {
    logError("BIGQUERY_DATASET_ID is missing. Cannot list BigQuery tables.");
    return null;
  }

  const bigQuery = getBigQueryApi();
  if (!bigQuery) {
    logError("BigQuery credentials/project are missing. Cannot list BigQuery tables.");
    return null;
  }

  try {
    const response = await bigQuery.client.tables.list({
      projectId: bigQuery.projectId,
      datasetId: resolvedDatasetId,
      maxResults: 1000,
    });

    const tables = (response.data.tables ?? []).map((table) => {
      const rawTable = table as Record<string, unknown>;
      return {
        tableName: String(table.tableReference?.tableId ?? ""),
        rowCount: toText(rawTable.numRows),
        sizeBytes: toText(rawTable.numBytes),
        lastModifiedTime: toText(rawTable.lastModifiedTime),
      };
    }).filter((table) => table.tableName.length > 0);

    return {
      projectId: bigQuery.projectId,
      datasetId: resolvedDatasetId,
      tables,
    };
  } catch (error) {
    logError(`Failed to list BigQuery tables for dataset ${resolvedDatasetId}`, String(error));
    return null;
  }
};

export type BigQueryTablePreview = {
  projectId: string;
  datasetId: string;
  tableName: string;
  headers: string[];
  rows: Array<Record<string, string>>;
  totalRows: string;
  pageToken: string;
  limit: number;
};

export const previewBigQueryTable = async (args: {
  tableName: string;
  datasetId?: string;
  limit?: number;
  pageToken?: string;
}): Promise<BigQueryTablePreview | null> => {
  const tableName = String(args.tableName ?? "").trim();
  if (!tableName) {
    logError("Missing BigQuery table name for preview.");
    return null;
  }

  const resolvedDatasetId = resolveDatasetId(args.datasetId);
  if (!resolvedDatasetId) {
    logError("BIGQUERY_DATASET_ID is missing. Cannot preview BigQuery rows.");
    return null;
  }

  const bigQuery = getBigQueryApi();
  if (!bigQuery) {
    logError("BigQuery credentials/project are missing. Cannot preview BigQuery rows.");
    return null;
  }

  const limit = toSafePreviewLimit(args.limit);
  const pageToken = String(args.pageToken ?? "").trim();

  try {
    const [tableResponse, rowsResponse] = await Promise.all([
      bigQuery.client.tables.get({
        projectId: bigQuery.projectId,
        datasetId: resolvedDatasetId,
        tableId: tableName,
      }),
      bigQuery.client.tabledata.list({
        projectId: bigQuery.projectId,
        datasetId: resolvedDatasetId,
        tableId: tableName,
        maxResults: limit,
        pageToken: pageToken || undefined,
      }),
    ]);

    const headers = getFieldNamesFromSchema(tableResponse.data.schema);
    const normalizedRows = normalizePreviewRows(rowsResponse.data.rows, headers);

    return {
      projectId: bigQuery.projectId,
      datasetId: resolvedDatasetId,
      tableName,
      headers,
      rows: normalizedRows,
      totalRows: String(tableResponse.data.numRows ?? "0"),
      pageToken: String(rowsResponse.data.pageToken ?? ""),
      limit,
    };
  } catch (error) {
    logError(`Failed to preview BigQuery table ${resolvedDatasetId}.${tableName}`, String(error));
    return null;
  }
};

export const appendRowsToBigQuery = async (args: {
  tableName: string;
  rows: Record<string, unknown>[];
  datasetId?: string;
}): Promise<boolean> => {
  if (args.rows.length === 0) {
    return true;
  }

  const datasetId = resolveDatasetId(args.datasetId);
  if (!datasetId) {
    logError("BIGQUERY_DATASET_ID is missing. Skipping BigQuery save.");
    return false;
  }

  const bigQuery = getBigQueryApi();
  if (!bigQuery) {
    logError("BigQuery credentials/project are missing. Skipping BigQuery save.");
    return false;
  }

  const tableReady = await ensureTableExists({
    client: bigQuery.client,
    projectId: bigQuery.projectId,
    datasetId,
    tableName: args.tableName,
    rows: args.rows,
  });
  if (!tableReady) {
    return false;
  }

  try {
    const normalizedRows = normalizeRows(args.rows);
    const response = await bigQuery.client.tabledata.insertAll({
      projectId: bigQuery.projectId,
      datasetId,
      tableId: args.tableName,
      requestBody: {
        rows: normalizedRows.map((row) => ({
          insertId: randomUUID(),
          json: row,
        })),
        ignoreUnknownValues: true,
        skipInvalidRows: false,
      },
    });

    const insertErrors = response.data.insertErrors;
    if (insertErrors && insertErrors.length > 0) {
      logError(`BigQuery insert failed for ${datasetId}.${args.tableName}`, insertErrors);
      return false;
    }

    return true;
  } catch (error) {
    logError(`BigQuery insert failed for ${datasetId}.${args.tableName}`, String(error));
    return false;
  }
};
