import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchBigQueryTablePreview, fetchBigQueryTables } from "../api/client";
import { ResultTable } from "../components/ResultTable";
import type { BigQueryTableSummary } from "../types";

const DEFAULT_PREVIEW_LIMIT = 50;

const formatTimestamp = (value: string): string => {
  const asNumber = Number(value);
  const millis = Number.isFinite(asNumber) ? asNumber : Number.NaN;
  if (!Number.isFinite(millis) || millis <= 0) {
    return "";
  }

  return new Date(millis).toLocaleString();
};

export function BigQueryPage() {
  const [datasetIdInput, setDatasetIdInput] = useState("");
  const [activeDatasetId, setActiveDatasetId] = useState("");
  const [tables, setTables] = useState<BigQueryTableSummary[]>([]);
  const [selectedTable, setSelectedTable] = useState("");
  const [previewRows, setPreviewRows] = useState<Array<Record<string, string>>>([]);
  const [previewLimit, setPreviewLimit] = useState(DEFAULT_PREVIEW_LIMIT);
  const [previewTotalRows, setPreviewTotalRows] = useState("0");
  const [previewPageToken, setPreviewPageToken] = useState("");
  const [loadingTables, setLoadingTables] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadTablePreview = useCallback(async (tableName: string, resetPageToken = true) => {
    const trimmedTable = tableName.trim();
    if (!trimmedTable) {
      setPreviewRows([]);
      setPreviewTotalRows("0");
      setPreviewPageToken("");
      return;
    }

    try {
      setLoadingPreview(true);
      setError(null);
      setStatus(`Loading preview for ${trimmedTable}...`);

      const response = await fetchBigQueryTablePreview({
        tableName: trimmedTable,
        datasetId: activeDatasetId,
        limit: previewLimit,
        pageToken: resetPageToken ? undefined : previewPageToken,
      });

      setPreviewRows(response.rows);
      setPreviewTotalRows(response.totalRows);
      setPreviewPageToken(response.pageToken);
      setStatus(`Loaded ${response.rows.length} row(s) from ${trimmedTable}.`);
    } catch (err) {
      setError(String(err));
      setStatus(null);
    } finally {
      setLoadingPreview(false);
    }
  }, [activeDatasetId, previewLimit, previewPageToken]);

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
        setPreviewRows([]);
        setPreviewTotalRows("0");
        setPreviewPageToken("");
        setStatus(`No tables found in dataset ${response.datasetId}.`);
        return;
      }

      const selected = response.tables.some((table) => table.tableName === selectedTable)
        ? selectedTable
        : response.tables[0].tableName;
      setSelectedTable(selected);
      setStatus(`Found ${response.tables.length} table(s) in dataset ${response.datasetId}.`);
    } catch (err) {
      setTables([]);
      setSelectedTable("");
      setPreviewRows([]);
      setPreviewTotalRows("0");
      setPreviewPageToken("");
      setError(String(err));
      setStatus(null);
    } finally {
      setLoadingTables(false);
    }
  }, [datasetIdInput, selectedTable]);

  useEffect(() => {
    void loadTables();
  }, [loadTables]);

  useEffect(() => {
    if (!selectedTable) {
      setPreviewRows([]);
      setPreviewTotalRows("0");
      setPreviewPageToken("");
      return;
    }

    void loadTablePreview(selectedTable, true);
  }, [loadTablePreview, selectedTable]);

  const sortedTables = useMemo(
    () => [...tables].sort((a, b) => a.tableName.localeCompare(b.tableName)),
    [tables],
  );
  const selectedTableInfo = useMemo(
    () => sortedTables.find((table) => table.tableName === selectedTable) ?? null,
    [selectedTable, sortedTables],
  );

  return (
    <div className="page-section">
      <section className="panel">
        <h3>BigQuery Tables</h3>
        <p className="muted">Browse dataset tables and preview rows using configured BigQuery credentials.</p>

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

        <div className="status-row">
          <span>Dataset: {activeDatasetId || "-"}</span>
          <span>Tables: {tables.length}</span>
          <span>Selected: {selectedTable || "-"}</span>
        </div>

        {status && <div className="live-status-line">{status}</div>}
        {error && <div className="error-box">{error}</div>}

        <div className="bigquery-layout">
          <section className="bigquery-table-list">
            <h4>Tables</h4>
            {sortedTables.length === 0 ? (
              <div className="result-empty">No tables to display.</div>
            ) : (
              <div className="bigquery-table-scroll">
                {sortedTables.map((table) => {
                  const isActive = table.tableName === selectedTable;
                  return (
                    <button
                      key={table.tableName}
                      type="button"
                      className={isActive ? "tab active" : "tab"}
                      onClick={() => setSelectedTable(table.tableName)}
                    >
                      {table.tableName}
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          <section className="bigquery-preview">
            <div className="bigquery-preview-header">
              <h4>Preview</h4>
              <div className="button-row">
                <label className="field-row-stacked">
                  Limit
                  <input
                    type="text"
                    value={String(previewLimit)}
                    onChange={(event) => {
                      const parsed = Number(event.target.value);
                      if (Number.isFinite(parsed) && parsed > 0) {
                        setPreviewLimit(Math.round(parsed));
                      }
                    }}
                  />
                </label>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void loadTablePreview(selectedTable, true)}
                  disabled={loadingPreview || !selectedTable}
                >
                  {loadingPreview ? "Loading..." : "Reload Preview"}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void loadTablePreview(selectedTable, false)}
                  disabled={loadingPreview || !selectedTable || !previewPageToken}
                >
                  Next Page
                </button>
              </div>
            </div>

            <div className="muted">
              Total rows: {previewTotalRows}{" "}
              {selectedTableInfo?.lastModifiedTime && (
                <>
                  | Last modified:{" "}
                  {formatTimestamp(selectedTableInfo.lastModifiedTime)}
                </>
              )}
            </div>

            <ResultTable rows={previewRows} maxHeight={520} />
          </section>
        </div>
      </section>
    </div>
  );
}
