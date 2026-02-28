import { Router } from "express";
import { analyzeDrilldownRows, getDrilldownSampleCsv } from "../services/drilldownService";
import { createJob } from "../utils/jobManager";
import { normalizeAiProvider } from "../utils/provider";

const router = Router();

router.get("/sample-template", (_req, res) => {
  const csv = getDrilldownSampleCsv();
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=drilldown_template.csv");
  res.send(csv);
});

router.post("/analyze", async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    const product = String(req.body?.product ?? "N/A");
    const provider = normalizeAiProvider(req.body?.provider);

    const result = await analyzeDrilldownRows(rows, product, provider);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

router.post("/analyze/start", async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    const product = String(req.body?.product ?? "N/A");
    const provider = normalizeAiProvider(req.body?.provider);

    const job = createJob(async (update, control) =>
      analyzeDrilldownRows(rows, product, provider, update, control.throwIfCancelled),
    );

    res.json({ jobId: job.id });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

export default router;
