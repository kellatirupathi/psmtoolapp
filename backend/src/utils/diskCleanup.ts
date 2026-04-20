import fs from "node:fs";
import path from "node:path";
import { APP_DIRS } from "../config";

const DEFAULT_TTL_HOURS = 48;
const DEFAULT_INTERVAL_HOURS = 1;

const parseHours = (raw: string | undefined, fallback: number): number => {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const removeStaleFiles = (dir: string, ttlMs: number): number => {
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  const now = Date.now();

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    try {
      const stats = fs.statSync(fullPath);
      if (now - stats.mtimeMs <= ttlMs) continue;

      if (entry.isDirectory()) {
        fs.rmSync(fullPath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(fullPath);
      }
      removed += 1;
    } catch {
      // ignore permission / transient errors
    }
  }
  return removed;
};

export const sweepTempDirectories = (): void => {
  const ttlHours = parseHours(process.env.TEMP_FILE_TTL_HOURS, DEFAULT_TTL_HOURS);
  const ttlMs = ttlHours * 3600 * 1000;
  const dirs = [
    APP_DIRS.downloadedVideos,
    APP_DIRS.generatedTranscripts,
    APP_DIRS.audioChunks,
    APP_DIRS.qa,
  ];

  let total = 0;
  for (const dir of dirs) {
    total += removeStaleFiles(dir, ttlMs);
  }

  if (total > 0) {
    // eslint-disable-next-line no-console
    console.log(`[diskCleanup] removed ${total} stale entries (TTL ${ttlHours}h).`);
  }
};

let intervalHandle: NodeJS.Timeout | null = null;

export const startDiskCleanupScheduler = (): void => {
  if (intervalHandle) return;
  const intervalHours = parseHours(process.env.TEMP_FILE_SWEEP_INTERVAL_HOURS, DEFAULT_INTERVAL_HOURS);
  sweepTempDirectories();
  intervalHandle = setInterval(sweepTempDirectories, intervalHours * 3600 * 1000);
  if (typeof intervalHandle.unref === "function") {
    intervalHandle.unref();
  }
};
