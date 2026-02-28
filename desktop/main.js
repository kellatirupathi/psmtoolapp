const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, dialog, shell } = require("electron");
const ffmpegPath = require("ffmpeg-static");
const ffprobeStatic = require("ffprobe-static");

const BACKEND_PORT = Number(process.env.BACKEND_PORT || 4000);
const BACKEND_HEALTH_URL = `http://127.0.0.1:${BACKEND_PORT}/api/health`;
const BACKEND_START_TIMEOUT_MS = 30000;
const HEALTH_CHECK_INTERVAL_MS = 600;

let mainWindow = null;
let backendLoaded = false;

const resolveAppPath = (...segments) => path.join(app.getAppPath(), ...segments);

const parseEnvFile = (filePath) => {
  const values = {};
  if (!fs.existsSync(filePath)) {
    return values;
  }

  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim().replace(/^"(.*)"$/, "$1");
    if (!key) {
      continue;
    }

    values[key] = value;
  }

  return values;
};

const loadDesktopEnvOverrides = () => {
  const candidates = [
    path.join(app.getPath("userData"), "desktop.env"),
    resolveAppPath("desktop", "desktop.env"),
  ];

  for (const candidate of candidates) {
    const parsed = parseEnvFile(candidate);
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined || process.env[key] === "") {
        process.env[key] = value;
      }
    }
  }
};

const getWritableBaseDir = () => path.join(app.getPath("documents"), "PSM-Analyser");

const ensureWritableBaseDir = () => {
  const baseDir = getWritableBaseDir();
  fs.mkdirSync(baseDir, { recursive: true });
  return baseDir;
};

const applyDesktopRuntimeEnv = () => {
  loadDesktopEnvOverrides();
  process.env.BACKEND_PORT = String(BACKEND_PORT);
  process.env.APP_BASE_DIR = process.env.APP_BASE_DIR || ensureWritableBaseDir();
  process.env.PROMPT_DIR = process.env.PROMPT_DIR || resolveAppPath("backend", "prompts");
  process.env.CURRICULUM_PATH = process.env.CURRICULUM_PATH || resolveAppPath("curriculum.txt");

  if (!process.env.FFMPEG_PATH && ffmpegPath) {
    process.env.FFMPEG_PATH = ffmpegPath;
  }

  const ffprobePath =
    typeof ffprobeStatic === "string" ? ffprobeStatic : ffprobeStatic?.path;
  if (!process.env.FFPROBE_PATH && ffprobePath) {
    process.env.FFPROBE_PATH = ffprobePath;
  }
};

const startBackend = () => {
  if (backendLoaded) {
    return;
  }

  applyDesktopRuntimeEnv();
  const backendEntry = resolveAppPath("backend", "dist", "server.js");
  // Loads and starts Express in-process for desktop runtime.
  require(backendEntry);
  backendLoaded = true;
};

const waitForBackend = async () => {
  const startedAt = Date.now();

  for (;;) {
    try {
      const response = await fetch(BACKEND_HEALTH_URL);
      if (response.ok) {
        return;
      }
    } catch {
      // Backend may still be booting.
    }

    if (Date.now() - startedAt > BACKEND_START_TIMEOUT_MS) {
      throw new Error(`Backend startup timed out after ${BACKEND_START_TIMEOUT_MS}ms.`);
    }

    await new Promise((resolve) => setTimeout(resolve, HEALTH_CHECK_INTERVAL_MS));
  }
};

const createMainWindow = () => {
  const indexPath = resolveAppPath("build", "index.html");
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 760,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    dialog.showErrorBox(
      "Desktop UI Failed to Load",
      `Failed to load ${validatedURL}\nError ${errorCode}: ${errorDescription}\n\nRebuild the desktop package and reinstall.`,
    );
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  void mainWindow.loadFile(indexPath);
};

const bootstrapDesktopApp = async () => {
  startBackend();
  await waitForBackend();
  createMainWindow();
};

app.whenReady()
  .then(bootstrapDesktopApp)
  .catch((error) => {
    void dialog.showErrorBox(
      "Desktop Startup Failed",
      `${String(error)}\n\nPlease verify backend build artifacts and desktop env values.`,
    );
    app.quit();
  });

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
