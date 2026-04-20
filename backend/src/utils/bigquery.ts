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

type BigQueryRowValue =
  | string
  | number
  | boolean
  | null
  | BigQueryRowValue[]
  | { [key: string]: BigQueryRowValue };
type BigQueryRowJson = Record<string, BigQueryRowValue>;
type InferredBigQuerySchemaField = { name: string; type: "STRING"; mode: "NULLABLE" };

export type BigQueryTableSchemaField = {
  name: string;
  type: string;
  mode: string;
};

export type BigQueryCsvUploadIssue = {
  scope: "file" | "schema" | "row";
  message: string;
  fieldName?: string;
  rowNumber?: number;
  expectedType?: string;
  receivedValue?: string;
};

export type BigQueryTableSummary = {
  tableName: string;
  rowCount: string;
  sizeBytes: string;
  lastModifiedTime: string;
};

export type BigQueryTableSchema = {
  projectId: string;
  datasetId: string;
  tableName: string;
  fields: BigQueryTableSchemaField[];
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

export type BigQueryCsvUploadResult = {
  ok: boolean;
  projectId: string;
  datasetId: string;
  tableName: string;
  fields: BigQueryTableSchemaField[];
  csvHeaders: string[];
  rowCount: number;
  insertedRowCount: number;
  issues: BigQueryCsvUploadIssue[];
  message: string;
};

const INTEGER_FIELD_TYPES = new Set(["INTEGER", "INT64", "INT"]);
const FLOAT_FIELD_TYPES = new Set(["FLOAT", "FLOAT64"]);
const DECIMAL_FIELD_TYPES = new Set(["NUMERIC", "BIGNUMERIC", "DECIMAL", "BIGDECIMAL"]);
const BOOLEAN_FIELD_TYPES = new Set(["BOOLEAN", "BOOL"]);
const STRING_FIELD_TYPES = new Set(["STRING", "BYTES", "GEOGRAPHY"]);
const UNSUPPORTED_CSV_FIELD_TYPES = new Set(["RECORD", "STRUCT"]);

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

const getSchemaFromRows = (rows: Record<string, unknown>[]): InferredBigQuerySchemaField[] => {
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

const normalizeFieldName = (value: unknown): string => String(value ?? "").trim();
const normalizeFieldType = (value: unknown): string => String(value ?? "STRING").trim().toUpperCase() || "STRING";
const normalizeFieldMode = (value: unknown): string => String(value ?? "NULLABLE").trim().toUpperCase() || "NULLABLE";
const normalizeColumnKey = (value: string): string => value.trim().toLowerCase();

const getSchemaFields = (schema: unknown): BigQueryTableSchemaField[] => {
  if (!schema || typeof schema !== "object") {
    return [];
  }

  const fields = (schema as { fields?: Array<{ name?: unknown; type?: unknown; mode?: unknown }> }).fields;
  if (!Array.isArray(fields)) {
    return [];
  }

  return fields
    .map((field) => ({
      name: normalizeFieldName(field?.name),
      type: normalizeFieldType(field?.type),
      mode: normalizeFieldMode(field?.mode),
    }))
    .filter((field) => field.name.length > 0);
};

const getFieldNamesFromSchema = (schema: unknown): string[] => {
  return getSchemaFields(schema).map((field) => field.name);
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

const normalizeJsonValue = (value: unknown): BigQueryRowValue => {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeJsonValue(item));
  }

  if (typeof value === "object") {
    const normalized: Record<string, BigQueryRowValue> = {};
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      normalized[key] = normalizeJsonValue(nestedValue);
    }
    return normalized;
  }

  return String(value);
};

const parseCsvCellValue = (
  rawValue: unknown,
  field: BigQueryTableSchemaField,
): { ok: true; value: BigQueryRowValue } | {
  ok: false;
  message: string;
  expectedType: string;
  receivedValue: string;
} => {
  const rawText = toText(rawValue);
  const trimmed = rawText.trim();

  if (!trimmed) {
    if (field.mode === "REQUIRED") {
      return {
        ok: false,
        message: `Field "${field.name}" is required but the CSV cell is empty.`,
        expectedType: `${field.type} (${field.mode})`,
        receivedValue: rawText,
      };
    }

    return { ok: true, value: null };
  }

  if (STRING_FIELD_TYPES.has(field.type)) {
    return { ok: true, value: rawText };
  }

  if (INTEGER_FIELD_TYPES.has(field.type)) {
    if (!/^[+-]?\d+$/.test(trimmed)) {
      return {
        ok: false,
        message: `Field "${field.name}" expects an integer value.`,
        expectedType: field.type,
        receivedValue: rawText,
      };
    }

    return { ok: true, value: trimmed };
  }

  if (FLOAT_FIELD_TYPES.has(field.type) || DECIMAL_FIELD_TYPES.has(field.type)) {
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      return {
        ok: false,
        message: `Field "${field.name}" expects a numeric value.`,
        expectedType: field.type,
        receivedValue: rawText,
      };
    }

    return { ok: true, value: trimmed };
  }

  if (BOOLEAN_FIELD_TYPES.has(field.type)) {
    const normalized = trimmed.toLowerCase();
    if (["true", "t", "1", "yes", "y"].includes(normalized)) {
      return { ok: true, value: true };
    }
    if (["false", "f", "0", "no", "n"].includes(normalized)) {
      return { ok: true, value: false };
    }

    return {
      ok: false,
      message: `Field "${field.name}" expects a boolean value.`,
      expectedType: field.type,
      receivedValue: rawText,
    };
  }

  if (field.type === "DATE") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return {
        ok: false,
        message: `Field "${field.name}" expects a DATE in YYYY-MM-DD format.`,
        expectedType: field.type,
        receivedValue: rawText,
      };
    }

    return { ok: true, value: trimmed };
  }

  if (field.type === "TIME") {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?$/.test(trimmed)) {
      return {
        ok: false,
        message: `Field "${field.name}" expects a TIME in HH:MM:SS format.`,
        expectedType: field.type,
        receivedValue: rawText,
      };
    }

    return { ok: true, value: trimmed };
  }

  if (field.type === "DATETIME") {
    if (!/^\d{4}-\d{2}-\d{2}[ T](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?$/.test(trimmed)) {
      return {
        ok: false,
        message: `Field "${field.name}" expects a DATETIME in YYYY-MM-DD HH:MM:SS format.`,
        expectedType: field.type,
        receivedValue: rawText,
      };
    }

    return { ok: true, value: trimmed };
  }

  if (field.type === "TIMESTAMP") {
    if (!Number.isFinite(Date.parse(trimmed)) && !/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) {
      return {
        ok: false,
        message: `Field "${field.name}" expects a valid TIMESTAMP.`,
        expectedType: field.type,
        receivedValue: rawText,
      };
    }

    return { ok: true, value: trimmed };
  }

  if (field.type === "JSON") {
    try {
      return { ok: true, value: normalizeJsonValue(JSON.parse(trimmed)) };
    } catch {
      return {
        ok: false,
        message: `Field "${field.name}" expects valid JSON text.`,
        expectedType: field.type,
        receivedValue: rawText,
      };
    }
  }

  return {
    ok: false,
    message: `Field "${field.name}" uses unsupported BigQuery type "${field.type}" for CSV upload.`,
    expectedType: field.type,
    receivedValue: rawText,
  };
};

const validateCsvRowsForSchema = (args: {
  fields: BigQueryTableSchemaField[];
  headers: string[];
  rows: Record<string, unknown>[];
}): {
  csvHeaders: string[];
  issues: BigQueryCsvUploadIssue[];
  preparedRows: BigQueryRowJson[];
} => {
  const csvHeaders = args.headers.map((header) => String(header ?? "").trim());
  const issues: BigQueryCsvUploadIssue[] = [];
  const preparedRows: BigQueryRowJson[] = [];
  const csvHeaderLookup = new Map<string, string>();
  const schemaFieldLookup = new Map<string, BigQueryTableSchemaField>();

  if (csvHeaders.length === 0) {
    issues.push({
      scope: "file",
      message: "The CSV file does not contain a header row.",
    });
  }

  if (args.rows.length === 0) {
    issues.push({
      scope: "file",
      message: "The CSV file does not contain any data rows to upload.",
    });
  }

  csvHeaders.forEach((header) => {
    if (!header) {
      issues.push({
        scope: "file",
        message: "The CSV file contains an empty column name.",
      });
      return;
    }

    const key = normalizeColumnKey(header);
    if (csvHeaderLookup.has(key)) {
      issues.push({
        scope: "file",
        fieldName: header,
        message: `Duplicate CSV column detected: "${header}".`,
      });
      return;
    }

    csvHeaderLookup.set(key, header);
  });

  if (args.fields.length === 0) {
    issues.push({
      scope: "schema",
      message: "The selected BigQuery table does not expose any top-level schema fields.",
    });
  }

  args.fields.forEach((field) => {
    schemaFieldLookup.set(normalizeColumnKey(field.name), field);

    if (field.mode === "REPEATED") {
      issues.push({
        scope: "schema",
        fieldName: field.name,
        expectedType: `${field.type} (${field.mode})`,
        message: `Field "${field.name}" uses REPEATED mode and cannot be loaded from this CSV uploader.`,
      });
    }

    if (UNSUPPORTED_CSV_FIELD_TYPES.has(field.type)) {
      issues.push({
        scope: "schema",
        fieldName: field.name,
        expectedType: field.type,
        message: `Field "${field.name}" uses unsupported nested type "${field.type}" for CSV upload.`,
      });
    }
  });

  args.fields.forEach((field) => {
    if (!csvHeaderLookup.has(normalizeColumnKey(field.name))) {
      issues.push({
        scope: "schema",
        fieldName: field.name,
        expectedType: `${field.type} (${field.mode})`,
        message: `Missing CSV column for BigQuery field "${field.name}".`,
      });
    }
  });

  csvHeaders.forEach((header) => {
    if (!header) return;
    if (!schemaFieldLookup.has(normalizeColumnKey(header))) {
      issues.push({
        scope: "schema",
        fieldName: header,
        message: `CSV column "${header}" does not exist in the selected BigQuery table schema.`,
      });
    }
  });

  if (issues.length > 0) {
    return { csvHeaders, issues, preparedRows };
  }

  args.rows.forEach((row, rowIndex) => {
    const preparedRow: BigQueryRowJson = {};

    args.fields.forEach((field) => {
      const sourceHeader = csvHeaderLookup.get(normalizeColumnKey(field.name)) ?? field.name;
      const parsed = parseCsvCellValue(row[sourceHeader], field);
      if (!parsed.ok) {
        issues.push({
          scope: "row",
          rowNumber: rowIndex + 2,
          fieldName: field.name,
          expectedType: parsed.expectedType,
          receivedValue: parsed.receivedValue,
          message: parsed.message,
        });
        return;
      }

      preparedRow[field.name] = parsed.value;
    });

    preparedRows.push(preparedRow);
  });

  return { csvHeaders, issues, preparedRows };
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

export const getBigQueryTableSchema = async (args: {
  tableName: string;
  datasetId?: string;
}): Promise<BigQueryTableSchema | null> => {
  const tableName = String(args.tableName ?? "").trim();
  if (!tableName) {
    logError("Missing BigQuery table name for schema lookup.");
    return null;
  }

  const resolvedDatasetId = resolveDatasetId(args.datasetId);
  if (!resolvedDatasetId) {
    logError("BIGQUERY_DATASET_ID is missing. Cannot fetch BigQuery schema.");
    return null;
  }

  const bigQuery = getBigQueryApi();
  if (!bigQuery) {
    logError("BigQuery credentials/project are missing. Cannot fetch BigQuery schema.");
    return null;
  }

  try {
    const response = await bigQuery.client.tables.get({
      projectId: bigQuery.projectId,
      datasetId: resolvedDatasetId,
      tableId: tableName,
    });

    return {
      projectId: bigQuery.projectId,
      datasetId: resolvedDatasetId,
      tableName,
      fields: getSchemaFields(response.data.schema),
    };
  } catch (error) {
    logError(`Failed to fetch BigQuery schema for ${resolvedDatasetId}.${tableName}`, String(error));
    return null;
  }
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

export const uploadCsvRowsToBigQuery = async (args: {
  tableName: string;
  headers: string[];
  rows: Record<string, unknown>[];
  datasetId?: string;
}): Promise<BigQueryCsvUploadResult | null> => {
  const tableName = String(args.tableName ?? "").trim();
  const datasetId = resolveDatasetId(args.datasetId);

  if (!tableName || !datasetId) {
    logError("Missing dataset or table for BigQuery CSV upload.");
    return null;
  }

  const bigQuery = getBigQueryApi();
  if (!bigQuery) {
    logError("BigQuery credentials/project are missing. Cannot upload CSV rows.");
    return null;
  }

  let fields: BigQueryTableSchemaField[] = [];

  try {
    const tableResponse = await bigQuery.client.tables.get({
      projectId: bigQuery.projectId,
      datasetId,
      tableId: tableName,
    });
    fields = getSchemaFields(tableResponse.data.schema);
  } catch (error) {
    if (isNotFoundError(error)) {
      return {
        ok: false,
        projectId: bigQuery.projectId,
        datasetId,
        tableName,
        fields,
        csvHeaders: args.headers.map((header) => String(header ?? "").trim()),
        rowCount: args.rows.length,
        insertedRowCount: 0,
        issues: [{
          scope: "schema",
          message: `Selected BigQuery table "${tableName}" was not found in dataset "${datasetId}".`,
        }],
        message: "Upload cancelled because the selected BigQuery table was not found.",
      };
    }

    logError(`Failed to fetch BigQuery table ${datasetId}.${tableName} for CSV upload`, String(error));
    return null;
  }

  const validation = validateCsvRowsForSchema({
    fields,
    headers: args.headers,
    rows: args.rows,
  });

  if (validation.issues.length > 0) {
    return {
      ok: false,
      projectId: bigQuery.projectId,
      datasetId,
      tableName,
      fields,
      csvHeaders: validation.csvHeaders,
      rowCount: args.rows.length,
      insertedRowCount: 0,
      issues: validation.issues,
      message: "Upload cancelled because the CSV data does not match the selected BigQuery table schema.",
    };
  }

  try {
    const response = await bigQuery.client.tabledata.insertAll({
      projectId: bigQuery.projectId,
      datasetId,
      tableId: tableName,
      requestBody: {
        rows: validation.preparedRows.map((row) => ({
          insertId: randomUUID(),
          json: row,
        })),
        ignoreUnknownValues: false,
        skipInvalidRows: false,
      },
    });

    const insertErrors = Array.isArray(response.data.insertErrors) ? response.data.insertErrors : [];
    if (insertErrors.length > 0) {
      const issues: BigQueryCsvUploadIssue[] = [];

      insertErrors.forEach((entry) => {
        const index = typeof entry.index === "number" ? entry.index : Number.NaN;
        const rowNumber = Number.isFinite(index) ? index + 2 : undefined;
        const rowErrors = Array.isArray(entry.errors) ? entry.errors : [];

        if (rowErrors.length === 0) {
          issues.push({
            scope: "row",
            rowNumber,
            message: "BigQuery rejected the row during upload.",
          });
          return;
        }

        rowErrors.forEach((rowError) => {
          issues.push({
            scope: "row",
            rowNumber,
            message: String(rowError.message ?? rowError.reason ?? "BigQuery rejected the row."),
          });
        });
      });

      logError(`BigQuery insert failed for ${datasetId}.${tableName}`, issues);

      return {
        ok: false,
        projectId: bigQuery.projectId,
        datasetId,
        tableName,
        fields,
        csvHeaders: validation.csvHeaders,
        rowCount: args.rows.length,
        insertedRowCount: 0,
        issues,
        message: "Upload cancelled because BigQuery rejected one or more rows.",
      };
    }

    return {
      ok: true,
      projectId: bigQuery.projectId,
      datasetId,
      tableName,
      fields,
      csvHeaders: validation.csvHeaders,
      rowCount: args.rows.length,
      insertedRowCount: validation.preparedRows.length,
      issues: [],
      message: `Uploaded ${validation.preparedRows.length} row(s) to ${datasetId}.${tableName}.`,
    };
  } catch (error) {
    logError(`BigQuery insert failed for ${datasetId}.${tableName}`, String(error));
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
