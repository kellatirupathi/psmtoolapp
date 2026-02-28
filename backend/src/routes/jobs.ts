import { Router } from "express";
import { cancelJob, getJob } from "../utils/jobManager";

const router = Router();

router.get("/:id", (req, res) => {
  const jobId = String(req.params.id ?? "").trim();
  if (!jobId) {
    res.status(400).json({ error: "Missing job id." });
    return;
  }

  const job = getJob(jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found." });
    return;
  }

  res.json(job);
});

router.post("/:id/cancel", (req, res) => {
  const jobId = String(req.params.id ?? "").trim();
  if (!jobId) {
    res.status(400).json({ error: "Missing job id." });
    return;
  }

  const cancelled = cancelJob(jobId);
  if (!cancelled) {
    res.status(404).json({ error: "Job not found." });
    return;
  }

  res.json(cancelled);
});

export default router;
