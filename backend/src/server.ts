import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import cors from "cors";
import metaRoutes from "./routes/meta";
import drilldownRoutes from "./routes/drilldown";
import assignmentsRoutes from "./routes/assignments";
import assessmentsRoutes from "./routes/assessments";
import interviewRoutes from "./routes/interview";
import jobsRoutes from "./routes/jobs";
import settingsRoutes from "./routes/settings";
import bigQueryRoutes from "./routes/bigquery";

const app = express();
const apiBodyLimit = process.env.API_BODY_LIMIT ?? "200mb";
const desktopReleaseDir = path.resolve(process.cwd(), "desktop", "releases");

app.use(cors());
app.use(express.json({ limit: apiBodyLimit }));
app.use(express.urlencoded({ extended: true, limit: apiBodyLimit }));

if (fs.existsSync(desktopReleaseDir)) {
  app.get("/downloads/:fileName", (req, res, next) => {
    const fileName = path.basename(String(req.params.fileName ?? "").trim());
    if (!fileName) {
      res.status(400).json({ error: "Missing file name." });
      return;
    }

    const filePath = path.join(desktopReleaseDir, fileName);
    const normalizedDir = path.resolve(desktopReleaseDir);
    const normalizedFilePath = path.resolve(filePath);
    if (!normalizedFilePath.startsWith(normalizedDir)) {
      res.status(400).json({ error: "Invalid file path." });
      return;
    }

    if (!fs.existsSync(normalizedFilePath)) {
      res.status(404).json({ error: "Download file not found." });
      return;
    }

    res.download(normalizedFilePath, fileName, (error) => {
      if (error) {
        next(error);
      }
    });
  });

  app.use("/downloads", express.static(desktopReleaseDir));
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

app.use("/api", metaRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/drilldown", drilldownRoutes);
app.use("/api/assignments", assignmentsRoutes);
app.use("/api/assessments", assessmentsRoutes);
app.use("/api/interview", interviewRoutes);
app.use("/api/jobs", jobsRoutes);
app.use("/api/bigquery", bigQueryRoutes);

app.use((error: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (error?.status === 413 || error?.type === "entity.too.large") {
    res.status(413).json({
      error: `Request payload too large. Current API_BODY_LIMIT=${apiBodyLimit}.`,
    });
    return;
  }

  next(error);
});

const port = Number(process.env.BACKEND_PORT ?? process.env.PORT ?? 4000);
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Backend server running on http://localhost:${port}`);
});
