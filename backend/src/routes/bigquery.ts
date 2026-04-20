import { Router } from "express";
import { BIGQUERY_DATASET_ID } from "../config";
import { getBigQueryTableSchema, listBigQueryTables, previewBigQueryTable, uploadCsvRowsToBigQuery } from "../utils/bigquery";

const router = Router();

const toOptionalText = (value: unknown): string | undefined => {
  const normalized = String(value ?? "").trim();
  return normalized.length > 0 ? normalized : undefined;
};

const isValidTableName = (value: string): boolean => /^[A-Za-z0-9_]+$/.test(value);

const toCsvHeaders = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((header) => String(header ?? ""));
};

const toCsvRows = (value: unknown): Record<string, unknown>[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row));
};

router.get("/tables", async (req, res) => {
  try {
    const datasetId = toOptionalText(req.query.datasetId) ?? BIGQUERY_DATASET_ID;
    const result = await listBigQueryTables(datasetId);
    if (!result) {
      res.status(500).json({ error: "Unable to fetch BigQuery tables. Verify credentials and dataset id." });
      return;
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

router.get("/tables/:tableName/preview", async (req, res) => {
  try {
    const tableName = String(req.params.tableName ?? "").trim();
    if (!tableName) {
      res.status(400).json({ error: "Table name is required." });
      return;
    }

    if (!isValidTableName(tableName)) {
      res.status(400).json({ error: "Invalid table name." });
      return;
    }

    const datasetId = toOptionalText(req.query.datasetId) ?? BIGQUERY_DATASET_ID;
    const limit = Number(req.query.limit ?? 50);
    const pageToken = toOptionalText(req.query.pageToken);

    const result = await previewBigQueryTable({
      datasetId,
      tableName,
      limit,
      pageToken,
    });

    if (!result) {
      res.status(500).json({ error: "Unable to fetch BigQuery table preview." });
      return;
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

router.get("/tables/:tableName/schema", async (req, res) => {
  try {
    const tableName = String(req.params.tableName ?? "").trim();
    if (!tableName) {
      res.status(400).json({ error: "Table name is required." });
      return;
    }

    if (!isValidTableName(tableName)) {
      res.status(400).json({ error: "Invalid table name." });
      return;
    }

    const datasetId = toOptionalText(req.query.datasetId) ?? BIGQUERY_DATASET_ID;
    const result = await getBigQueryTableSchema({
      datasetId,
      tableName,
    });

    if (!result) {
      res.status(500).json({ error: "Unable to fetch BigQuery table schema." });
      return;
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

router.post("/tables/:tableName/upload-csv", async (req, res) => {
  try {
    const tableName = String(req.params.tableName ?? "").trim();
    if (!tableName) {
      res.status(400).json({ error: "Table name is required." });
      return;
    }

    if (!isValidTableName(tableName)) {
      res.status(400).json({ error: "Invalid table name." });
      return;
    }

    const datasetId = toOptionalText(req.body?.datasetId) ?? BIGQUERY_DATASET_ID;
    const headers = toCsvHeaders(req.body?.headers);
    const rows = toCsvRows(req.body?.rows);

    const result = await uploadCsvRowsToBigQuery({
      datasetId,
      tableName,
      headers,
      rows,
    });

    if (!result) {
      res.status(500).json({ error: "Unable to upload CSV rows to BigQuery." });
      return;
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

export default router;
