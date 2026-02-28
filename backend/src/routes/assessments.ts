import { Router } from "express";
import multer from "multer";
import { analyzeAssessmentIndividual, analyzeAssessmentZip } from "../services/assessmentsService";
import { createJob } from "../utils/jobManager";
import { normalizeAiProvider } from "../utils/provider";

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

const toFileMap = (files: Express.Multer.File[] | undefined): Map<string, Express.Multer.File> => {
  const map = new Map<string, Express.Multer.File>();
  for (const file of files ?? []) {
    map.set(file.fieldname, file);
  }
  return map;
};

router.post("/individual", upload.any(), async (req, res) => {
  try {
    const rowsRaw = typeof req.body?.rows === "string" ? req.body.rows : "[]";
    const rows = JSON.parse(rowsRaw);
    const product = String(req.body?.product ?? "N/A");
    const provider = normalizeAiProvider(req.body?.provider);

    const fileMap = toFileMap(req.files as Express.Multer.File[]);
    const result = await analyzeAssessmentIndividual({
      rows,
      files: fileMap,
      product,
      provider,
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

router.post("/individual/start", upload.any(), async (req, res) => {
  try {
    const rowsRaw = typeof req.body?.rows === "string" ? req.body.rows : "[]";
    const rows = JSON.parse(rowsRaw);
    const product = String(req.body?.product ?? "N/A");
    const provider = normalizeAiProvider(req.body?.provider);

    const fileMap = toFileMap(req.files as Express.Multer.File[]);
    const job = createJob(async (update, control) =>
      analyzeAssessmentIndividual({
        rows,
        files: fileMap,
        product,
        provider,
        onStatus: update,
        abortIfCancelled: control.throwIfCancelled,
      }),
    );

    res.json({ jobId: job.id });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

router.post("/zip", upload.any(), async (req, res) => {
  try {
    const rowsRaw = typeof req.body?.rows === "string" ? req.body.rows : "[]";
    const rows = JSON.parse(rowsRaw);
    const product = String(req.body?.product ?? "N/A");
    const provider = normalizeAiProvider(req.body?.provider);

    const fileMap = toFileMap(req.files as Express.Multer.File[]);
    const result = await analyzeAssessmentZip({
      rows,
      files: fileMap,
      product,
      provider,
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

router.post("/zip/start", upload.any(), async (req, res) => {
  try {
    const rowsRaw = typeof req.body?.rows === "string" ? req.body.rows : "[]";
    const rows = JSON.parse(rowsRaw);
    const product = String(req.body?.product ?? "N/A");
    const provider = normalizeAiProvider(req.body?.provider);

    const fileMap = toFileMap(req.files as Express.Multer.File[]);
    const job = createJob(async (update, control) =>
      analyzeAssessmentZip({
        rows,
        files: fileMap,
        product,
        provider,
        onStatus: update,
        abortIfCancelled: control.throwIfCancelled,
      }),
    );

    res.json({ jobId: job.id });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

export default router;
