import { randomUUID } from "node:crypto";
import { google } from "googleapis";
import { BIGQUERY_DATASET_ID, BIGQUERY_PROJECT_ID, getBigQueryServiceAccountCredentials } from "../config";
import { logError } from "./logger";

const DEFAULT_BIGQUERY_SCOPES = [
  "https://www.googleapis.com/auth/bigquery",
  "https://www.googleapis.com/auth/bigquery.insertdata",
];

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

export const appendRowsToBigQuery = async (args: {
  tableName: string;
  rows: Record<string, unknown>[];
  datasetId?: string;
}): Promise<boolean> => {
  if (args.rows.length === 0) {
    return true;
  }

  const datasetId = args.datasetId ?? BIGQUERY_DATASET_ID;
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
