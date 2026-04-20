import { type ChangeEvent, useCallback, useEffect, useMemo, useState } from "react";
import Papa from "papaparse";
import {
  fetchBigQueryTableSchema,
  fetchBigQueryTables,
  uploadCsvRowsToBigQuery,
} from "../api/client";
import { ResultTable } from "../components/ResultTable";
import type {
  BigQueryCsvUploadIssue,
  BigQueryCsvUploadResponse,
  BigQueryTableSchemaField,
  BigQueryTableSummary,
} from "../types";

const PREVIEW_ROW_LIMIT = 20;

type ParsedCsvFile = {
  fileName: string;
  headers: string[];
  rows: Array<Record<string, string>>;
  issues: BigQueryCsvUploadIssue[];
};

const normalizeColumnKey = (value: string): string => value.trim().toLowerCase();

const MAX_CSV_FILE_BYTES = 50 * 1024 * 1024;
const MAX_CSV_ROWS = 20000;

const parseCsvFile = (file: File): Promise<ParsedCsvFile> => {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_CSV_FILE_BYTES) {
      resolve({
        fileName: file.name,
        headers: [],
        rows: [],
        issues: [
          {
            scope: "file",
            message: `File is ${(file.size / (1024 * 1024)).toFixed(1)} MB. Max allowed is ${MAX_CSV_FILE_BYTES / (1024 * 1024)} MB — split the file into smaller uploads.`,
          },
        ],
      });
      return;
    }

    Papa.parse<string[]>(file, {
      skipEmptyLines: "greedy",
      complete: (result) => {
        const issues: BigQueryCsvUploadIssue[] = [];

        result.errors.forEach((error) => {
          issues.push({
            scope: "file",
            message: `CSV parse error: ${error.message}`,
          });
        });

        const rawRows = Array.isArray(result.data) ? result.data : [];
        if (rawRows.length === 0) {
          resolve({
            fileName: file.name,
            headers: [],
            rows: [],
            issues: [
              ...issues,
              {
                scope: "file",
                message: "The selected CSV file is empty.",
              },
            ],
          });
          return;
        }

        const headers = rawRows[0].map((header) => String(header ?? "").trim());
        const dataRows = rawRows.slice(1);
        if (dataRows.length > MAX_CSV_ROWS) {
          issues.push({
            scope: "file",
            message: `CSV has ${dataRows.length} rows. Max supported per upload is ${MAX_CSV_ROWS}. Split the file or raise MAX_CSV_ROWS.`,
          });
        }
        const rows = dataRows.slice(0, MAX_CSV_ROWS).map((rawRow, rowIndex) => {
          const normalizedRow: Record<string, string> = {};

          if (rawRow.length > headers.length) {
            issues.push({
              scope: "file",
              rowNumber: rowIndex + 2,
              message: `Row ${rowIndex + 2} contains extra values beyond the header columns.`,
            });
          }

          headers.forEach((header, columnIndex) => {
            if (!header) {
              return;
            }

            normalizedRow[header] = String(rawRow[columnIndex] ?? "");
          });

          return normalizedRow;
        });

        resolve({
          fileName: file.name,
          headers,
          rows,
          issues,
        });
      },
      error: (error) => {
        reject(error);
      },
    });
  });
};

const buildClientValidationIssues = (
  headers: string[],
  schemaFields: BigQueryTableSchemaField[],
  parseIssues: BigQueryCsvUploadIssue[],
): BigQueryCsvUploadIssue[] => {
  const issues = [...parseIssues];
  const csvLookup = new Map<string, string>();
  const schemaLookup = new Map<string, BigQueryTableSchemaField>();

  headers.forEach((header) => {
    if (!header) {
      issues.push({
        scope: "file",
        message: "The CSV contains an empty column name.",
      });
      return;
    }

    const key = normalizeColumnKey(header);
    if (csvLookup.has(key)) {
      issues.push({
        scope: "file",
        fieldName: header,
        message: `Duplicate CSV column detected: "${header}".`,
      });
      return;
    }

    csvLookup.set(key, header);
  });

  schemaFields.forEach((field) => {
    schemaLookup.set(normalizeColumnKey(field.name), field);
  });

  schemaFields.forEach((field) => {
    if (!csvLookup.has(normalizeColumnKey(field.name))) {
      issues.push({
        scope: "schema",
        fieldName: field.name,
        expectedType: `${field.type} (${field.mode})`,
        message: `Missing CSV column for BigQuery field "${field.name}".`,
      });
    }
  });

  headers.forEach((header) => {
    if (!header) {
      return;
    }

    if (!schemaLookup.has(normalizeColumnKey(header))) {
      issues.push({
        scope: "schema",
        fieldName: header,
        message: `CSV column "${header}" does not exist in the selected BigQuery table.`,
      });
    }
  });

  return issues;
};

const formatIssue = (issue: BigQueryCsvUploadIssue): string => {
  const parts: string[] = [];

  if (typeof issue.rowNumber === "number") {
    parts.push(`Row ${issue.rowNumber}`);
  }

  if (issue.fieldName) {
    parts.push(`Field "${issue.fieldName}"`);
  }

  parts.push(issue.message);
  return parts.join(" | ");
};

export function BigQueryUploadPage() {
  const [datasetIdInput, setDatasetIdInput] = useState("");
  const [activeDatasetId, setActiveDatasetId] = useState("");
  const [tables, setTables] = useState<BigQueryTableSummary[]>([]);
  const [selectedTable, setSelectedTable] = useState("");
  const [schemaFields, setSchemaFields] = useState<BigQueryTableSchemaField[]>([]);
  const [csvFileName, setCsvFileName] = useState("");
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvRows, setCsvRows] = useState<Array<Record<string, string>>>([]);
  const [parseIssues, setParseIssues] = useState<BigQueryCsvUploadIssue[]>([]);
  const [loadingTables, setLoadingTables] = useState(false);
  const [loadingSchema, setLoadingSchema] = useState(false);
  const [parsingFile, setParsingFile] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploadResult, setUploadResult] = useState<BigQueryCsvUploadResponse | null>(null);

  const loadTables = useCallback(async () => {
    try {
      setLoadingTables(true);
      setError(null);
      setStatus("Loading BigQuery tables...");

      const response = await fetchBigQueryTables(datasetIdInput);
      setTables(response.tables);
      setActiveDatasetId(response.datasetId);
      setDatasetIdInput(response.datasetId);

      if (response.tables.length === 0) {
        setSelectedTable("");
        setSchemaFields([]);
        setStatus(`No tables found in dataset ${response.datasetId}.`);
        return;
      }

      setSelectedTable((prev) =>
        response.tables.some((table) => table.tableName === prev)
          ? prev
          : response.tables[0].tableName
      );
      setStatus(`Loaded ${response.tables.length} table(s) from dataset ${response.datasetId}.`);
    } catch (err) {
      setTables([]);
      setSelectedTable("");
      setSchemaFields([]);
      setError(String(err));
      setStatus(null);
    } finally {
      setLoadingTables(false);
    }
  }, [datasetIdInput]);

  const loadSchema = useCallback(async (tableName: string) => {
    const trimmedTable = tableName.trim();
    if (!trimmedTable) {
      setSchemaFields([]);
      return;
    }

    try {
      setLoadingSchema(true);
      setError(null);
      setStatus(`Loading schema for ${trimmedTable}...`);

      const response = await fetchBigQueryTableSchema({
        tableName: trimmedTable,
        datasetId: activeDatasetId,
      });

      setSchemaFields(response.fields);
      setStatus(`Loaded schema for ${trimmedTable}.`);
    } catch (err) {
      setSchemaFields([]);
      setError(String(err));
      setStatus(null);
    } finally {
      setLoadingSchema(false);
    }
  }, [activeDatasetId]);

  useEffect(() => {
    void loadTables();
  }, [loadTables]);

  useEffect(() => {
    if (!selectedTable) {
      setSchemaFields([]);
      return;
    }

    void loadSchema(selectedTable);
  }, [loadSchema, selectedTable]);

  const sortedTables = useMemo(
    () => [...tables].sort((a, b) => a.tableName.localeCompare(b.tableName)),
    [tables],
  );

  const clientValidationIssues = useMemo(
    () => buildClientValidationIssues(csvHeaders, schemaFields, parseIssues),
    [csvHeaders, parseIssues, schemaFields],
  );

  const previewRows = useMemo(
    () => csvRows.slice(0, PREVIEW_ROW_LIMIT),
    [csvRows],
  );

  const handleSelectFile = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    setUploadResult(null);

    if (!file) {
      setCsvFileName("");
      setCsvHeaders([]);
      setCsvRows([]);
      setParseIssues([]);
      setStatus(null);
      return;
    }

    try {
      setParsingFile(true);
      setError(null);
      setStatus(`Parsing ${file.name}...`);

      const parsed = await parseCsvFile(file);
      setCsvFileName(parsed.fileName);
      setCsvHeaders(parsed.headers);
      setCsvRows(parsed.rows);
      setParseIssues(parsed.issues);
      setStatus(`Parsed ${parsed.rows.length} row(s) from ${parsed.fileName}.`);
    } catch (err) {
      setCsvFileName(file.name);
      setCsvHeaders([]);
      setCsvRows([]);
      setParseIssues([{
        scope: "file",
        message: `Unable to parse CSV file: ${String(err)}`,
      }]);
      setStatus(null);
    } finally {
      setParsingFile(false);
    }
  }, []);

  const handleUpload = useCallback(async () => {
    if (!selectedTable) {
      setError("Select a BigQuery table before uploading.");
      return;
    }

    if (csvRows.length === 0) {
      setError("Select a CSV file with at least one data row before uploading.");
      return;
    }

    if (clientValidationIssues.length > 0) {
      setError("Fix the CSV or schema mismatches before uploading.");
      setStatus(null);
      return;
    }

    try {
      setUploading(true);
      setError(null);
      setUploadResult(null);
      setStatus(`Uploading ${csvRows.length} row(s) to ${selectedTable}...`);

      const response = await uploadCsvRowsToBigQuery({
        tableName: selectedTable,
        datasetId: activeDatasetId,
        headers: csvHeaders,
        rows: csvRows,
      });

      setUploadResult(response);
      setStatus(response.message);
    } catch (err) {
      setUploadResult(null);
      setError(String(err));
      setStatus(null);
    } finally {
      setUploading(false);
    }
  }, [activeDatasetId, clientValidationIssues.length, csvHeaders, csvRows, selectedTable]);

  return (
    <div className="page-section">
      <section className="panel">
        <h3>BigQuery CSV Upload</h3>
        <p className="muted">
          Hidden web-only page for uploading CSV rows into an existing BigQuery table after strict schema validation.
        </p>

        <div className="field-row">
          <label className="field-row-stacked">
            Dataset ID
            <input
              type="text"
              value={datasetIdInput}
              onChange={(event) => setDatasetIdInput(event.target.value)}
              placeholder="Enter dataset id"
            />
          </label>
          <button
            type="button"
            className="secondary-button"
            onClick={() => void loadTables()}
            disabled={loadingTables}
          >
            {loadingTables ? "Loading..." : "Refresh Tables"}
          </button>
        </div>

        <div className="field-row">
          <label className="field-row-stacked">
            Table Name
            <select
              value={selectedTable}
              onChange={(event) => setSelectedTable(event.target.value)}
              disabled={loadingTables || sortedTables.length === 0}
            >
              {sortedTables.length === 0 ? (
                <option value="">No tables available</option>
              ) : (
                sortedTables.map((table) => (
                  <option key={table.tableName} value={table.tableName}>
                    {table.tableName}
                  </option>
                ))
              )}
            </select>
          </label>
        </div>

        <label className="file-input">
          CSV File
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => void handleSelectFile(event)}
            disabled={parsingFile}
          />
        </label>

        <div className="status-row">
          <span>Dataset: {activeDatasetId || "-"}</span>
          <span>Table: {selectedTable || "-"}</span>
          <span>File: {csvFileName || "-"}</span>
          <span>Rows: {csvRows.length}</span>
        </div>

        {status && <div className="live-status-line">{status}</div>}
        {error && <div className="error-box">{error}</div>}

        <div className="upload-layout">
          <section className="upload-card">
            <h4>Expected Table Schema</h4>
            <p className="muted">
              The CSV must match these columns exactly by name. Upload is blocked on any mismatch.
            </p>
            {loadingSchema ? (
              <div className="result-empty">Loading schema...</div>
            ) : schemaFields.length === 0 ? (
              <div className="result-empty">No schema fields loaded.</div>
            ) : (
              <div className="field-chip-list">
                {schemaFields.map((field) => (
                  <div key={field.name} className="field-chip">
                    <strong>{field.name}</strong>
                    <span>{field.type}</span>
                    <span>{field.mode}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="upload-card">
            <h4>CSV Columns</h4>
            <p className="muted">
              Parsed headers from the selected file.
            </p>
            {csvHeaders.length === 0 ? (
              <div className="result-empty">No CSV headers parsed yet.</div>
            ) : (
              <div className="field-chip-list">
                {csvHeaders.map((header, index) => (
                  <div key={`${header}-${index}`} className="field-chip">
                    <strong>{header || "(blank)"}</strong>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        {clientValidationIssues.length > 0 && (
          <div className="error-box">
            <strong>Validation issues</strong>
            <ul className="issue-list">
              {clientValidationIssues.map((issue, index) => (
                <li key={`${issue.message}-${index}`}>{formatIssue(issue)}</li>
              ))}
            </ul>
          </div>
        )}

        {uploadResult && !uploadResult.ok && uploadResult.issues.length > 0 && (
          <div className="error-box">
            <strong>Upload blocked</strong>
            <ul className="issue-list">
              {uploadResult.issues.map((issue, index) => (
                <li key={`${issue.message}-${index}`}>{formatIssue(issue)}</li>
              ))}
            </ul>
          </div>
        )}

        {uploadResult?.ok && (
          <div className="live-status-line">
            {uploadResult.message}
          </div>
        )}

        <div className="button-row">
          <button
            type="button"
            className="primary-button"
            onClick={() => void handleUpload()}
            disabled={uploading || parsingFile || loadingSchema || !selectedTable || csvRows.length === 0}
          >
            {uploading ? "Uploading..." : "Upload to BigQuery"}
          </button>
        </div>

        <section className="upload-card">
          <h4>CSV Preview</h4>
          <p className="muted">
            Showing the first {Math.min(previewRows.length, PREVIEW_ROW_LIMIT)} row(s) from the selected CSV file.
          </p>
          <ResultTable rows={previewRows} maxHeight={420} />
        </section>
      </section>
    </div>
  );
}
