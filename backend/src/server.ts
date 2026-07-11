// Load .env if dotenv is available. In the packaged desktop app the env
// is already applied by desktop/main.js before this module is required, so
// dotenv is not required at runtime. Wrapping in try/catch keeps startup
// working even when the dotenv package is missing from the asar bundle.
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  require("dotenv/config");
} catch {
  // dotenv is optional; env vars must already be set by the parent process.
}
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
import { startDiskCleanupScheduler } from "./utils/diskCleanup";

const app = express();
const apiBodyLimit = process.env.API_BODY_LIMIT ?? "200mb";
const desktopReleaseDir = path.resolve(process.cwd(), "desktop", "releases");

const allowedOrigins = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const isLocalhostOrigin = (origin: string): boolean => {
  try {
    const { hostname, protocol } = new URL(origin);
    if (protocol === "file:") return true;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
};

const corsOptions: cors.CorsOptions = allowedOrigins.length === 0
  ? {}
  : {
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin) || isLocalhostOrigin(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error(`Origin ${origin} not allowed by CORS.`));
      },
    };

app.use(cors(corsOptions));
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
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: "Download file not found." });
      return;
    }

    let resolvedDir: string;
    let resolvedFilePath: string;
    try {
      resolvedDir = fs.realpathSync(desktopReleaseDir);
      resolvedFilePath = fs.realpathSync(filePath);
    } catch {
      res.status(400).json({ error: "Invalid file path." });
      return;
    }

    const relative = path.relative(resolvedDir, resolvedFilePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      res.status(400).json({ error: "Invalid file path." });
      return;
    }

    res.download(resolvedFilePath, fileName, (error) => {
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
const server = app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Backend server running on http://localhost:${port}`);
  startDiskCleanupScheduler();
});

server.on("error", (error: NodeJS.ErrnoException) => {
  // eslint-disable-next-line no-console
  if (error.code === "EADDRINUSE") {
    console.error(
      `Backend port ${port} is already in use. Another instance may be running. ` +
        `Set BACKEND_PORT to a free port or close the other process.`,
    );
  } else {
    console.error(`Backend failed to start: ${error.message}`);
  }
  process.exit(1);
});
