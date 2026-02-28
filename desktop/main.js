const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, dialog, shell, ipcMain } = require("electron");
const { autoUpdater } = require("electron-updater");
const ffmpegPath = require("ffmpeg-static");
const ffprobeStatic = require("ffprobe-static");

const BACKEND_PORT = Number(process.env.BACKEND_PORT || 4000);
const BACKEND_HEALTH_URL = `http://127.0.0.1:${BACKEND_PORT}/api/health`;
const BACKEND_START_TIMEOUT_MS = 30000;
const HEALTH_CHECK_INTERVAL_MS = 600;
const UPDATE_CHECK_DELAY_MS = 4000;
const DESKTOP_ENV_FILE = "desktop.env";

let mainWindow = null;
let backendLoaded = false;
let updateProgressWindow = null;
let updateFlowInitialized = false;
let isUpdateDownloadRequested = false;

const resolveAppPath = (...segments) => path.join(app.getAppPath(), ...segments);
const withMainWindow = () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null);
const getUserDesktopEnvPath = () => path.join(app.getPath("userData"), DESKTOP_ENV_FILE);

const getPackagedDesktopEnvCandidates = () => {
  const candidates = [resolveAppPath("desktop", DESKTOP_ENV_FILE)];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "desktop", DESKTOP_ENV_FILE));
    candidates.push(path.join(process.resourcesPath, "app.asar.unpacked", "desktop", DESKTOP_ENV_FILE));
  }
  return candidates;
};

const ensureUserDesktopEnv = () => {
  const userDesktopEnvPath = getUserDesktopEnvPath();
  if (fs.existsSync(userDesktopEnvPath)) {
    return;
  }

  const packagedDesktopEnv = getPackagedDesktopEnvCandidates().find((candidate) => fs.existsSync(candidate));
  if (!packagedDesktopEnv) {
    return;
  }

  fs.mkdirSync(path.dirname(userDesktopEnvPath), { recursive: true });
  fs.copyFileSync(packagedDesktopEnv, userDesktopEnvPath);
};

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
  ensureUserDesktopEnv();
  const candidates = [
    getUserDesktopEnvPath(),
    ...getPackagedDesktopEnvCandidates(),
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

const updateProgressWindowHtml = `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title>PSM Analyser Update</title>
    <style>
      body {
        margin: 0;
        padding: 16px;
        font-family: "Segoe UI", Tahoma, sans-serif;
        background: #f3f5f8;
        color: #0f2236;
      }
      .card {
        border: 1px solid #d5dce5;
        border-radius: 12px;
        background: #ffffff;
        padding: 14px;
      }
      h3 {
        margin: 0 0 8px 0;
        font-size: 16px;
      }
      p {
        margin: 0;
        font-size: 13px;
        color: #4d647f;
      }
      .track {
        margin-top: 12px;
        width: 100%;
        height: 12px;
        background: #e9eef4;
        border-radius: 999px;
        overflow: hidden;
      }
      .bar {
        width: 0%;
        height: 100%;
        background: linear-gradient(90deg, #0f9fb5, #42d3c6);
        transition: width 0.2s ease;
      }
      .pct {
        margin-top: 10px;
        font-size: 13px;
        font-weight: 600;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <h3>Updating PSM Analyser</h3>
      <p id="status">Preparing update...</p>
      <div class="track"><div id="bar" class="bar"></div></div>
      <div id="percent" class="pct">0.0%</div>
    </div>
  </body>
</html>`;

const createUpdateProgressWindow = () => {
  if (updateProgressWindow && !updateProgressWindow.isDestroyed()) {
    return updateProgressWindow;
  }

  updateProgressWindow = new BrowserWindow({
    width: 430,
    height: 190,
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    autoHideMenuBar: true,
    parent: withMainWindow() || undefined,
    modal: Boolean(withMainWindow()),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  updateProgressWindow.on("closed", () => {
    updateProgressWindow = null;
  });

  void updateProgressWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(updateProgressWindowHtml)}`);
  updateProgressWindow.once("ready-to-show", () => {
    updateProgressWindow?.show();
  });

  return updateProgressWindow;
};

const setMainWindowProgress = (percent) => {
  const activeWindow = withMainWindow();
  if (!activeWindow) return;

  if (Number.isFinite(percent) && percent >= 0) {
    activeWindow.setProgressBar(Math.max(0, Math.min(1, percent / 100)));
  } else {
    activeWindow.setProgressBar(-1);
  }
};

const showUpdateProgress = (statusText, percent) => {
  const safePercent = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
  const safeStatus = String(statusText || "Downloading update...");
  const win = createUpdateProgressWindow();

  setMainWindowProgress(safePercent);

  if (!win || win.isDestroyed()) return;

  const script = `(() => {
    const status = document.getElementById("status");
    const bar = document.getElementById("bar");
    const pct = document.getElementById("percent");
    if (status) status.textContent = ${JSON.stringify(safeStatus)};
    if (bar) bar.style.width = ${JSON.stringify(`${safePercent.toFixed(1)}%`)};
    if (pct) pct.textContent = ${JSON.stringify(`${safePercent.toFixed(1)}%`)};
  })();`;

  void win.webContents.executeJavaScript(script).catch(() => {
    // Ignore best-effort UI updates.
  });
};

const closeUpdateProgress = () => {
  setMainWindowProgress(-1);
  if (updateProgressWindow && !updateProgressWindow.isDestroyed()) {
    updateProgressWindow.close();
  }
  updateProgressWindow = null;
};

const setupAutoUpdates = () => {
  if (updateFlowInitialized || !app.isPackaged) {
    return;
  }

  const updateEnabled = String(process.env.DESKTOP_AUTO_UPDATE ?? "true").trim().toLowerCase() !== "false";
  if (!updateEnabled) {
    return;
  }

  updateFlowInitialized = true;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on("update-available", async (info) => {
    const newVersion = String(info?.version ?? "latest");
    const choice = await dialog.showMessageBox(withMainWindow() || undefined, {
      type: "info",
      title: "Update Available",
      message: `A new version (${newVersion}) is available.`,
      detail: "Click 'Update Application' to download and install this update.",
      buttons: ["Update Application", "Later"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });

    if (choice.response !== 0) {
      return;
    }

    isUpdateDownloadRequested = true;
    showUpdateProgress("Starting update download...", 0);

    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      isUpdateDownloadRequested = false;
      closeUpdateProgress();
      await dialog.showMessageBox(withMainWindow() || undefined, {
        type: "error",
        title: "Update Failed",
        message: "Unable to download the update.",
        detail: String(error),
      });
    }
  });

  autoUpdater.on("download-progress", (progress) => {
    if (!isUpdateDownloadRequested) return;

    const percent = Number(progress?.percent ?? 0);
    const transferredMb = Math.round(Number(progress?.transferred ?? 0) / (1024 * 1024));
    const totalMb = Math.round(Number(progress?.total ?? 0) / (1024 * 1024));
    const detail = totalMb > 0
      ? `Downloading update... ${percent.toFixed(1)}% (${transferredMb} MB / ${totalMb} MB)`
      : `Downloading update... ${percent.toFixed(1)}%`;

    showUpdateProgress(detail, percent);
  });

  autoUpdater.on("update-downloaded", async () => {
    isUpdateDownloadRequested = false;
    showUpdateProgress("Update downloaded. Ready to install.", 100);

    const choice = await dialog.showMessageBox(withMainWindow() || undefined, {
      type: "info",
      title: "Update Ready",
      message: "Update download completed successfully.",
      detail: "Click 'Restart and Install' to apply new features now.",
      buttons: ["Restart and Install", "Later"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });

    closeUpdateProgress();

    if (choice.response === 0) {
      autoUpdater.quitAndInstall(false, true);
    }
  });

  autoUpdater.on("error", (error) => {
    if (isUpdateDownloadRequested) {
      isUpdateDownloadRequested = false;
      closeUpdateProgress();
      void dialog.showMessageBox(withMainWindow() || undefined, {
        type: "error",
        title: "Update Error",
        message: "Desktop updater encountered an error.",
        detail: String(error),
      });
    }

    // eslint-disable-next-line no-console
    console.error("autoUpdater error:", error);
  });

  setTimeout(() => {
    void autoUpdater.checkForUpdates().catch((error) => {
      // eslint-disable-next-line no-console
      console.error("autoUpdater checkForUpdates failed:", error);
    });
  }, UPDATE_CHECK_DELAY_MS);
};

const setupDesktopIpc = () => {
  ipcMain.handle("desktop-updater:check", async () => {
    if (!app.isPackaged) {
      return {
        ok: false,
        message: "Update checks are available only in installed desktop app builds.",
      };
    }

    setupAutoUpdates();

    if (isUpdateDownloadRequested) {
      return {
        ok: false,
        message: "An update download is already in progress.",
      };
    }

    try {
      const result = await autoUpdater.checkForUpdates();
      const currentVersion = app.getVersion();
      const availableVersion = result?.updateInfo?.version ?? currentVersion;
      const hasUpdate = availableVersion !== currentVersion;

      if (!hasUpdate) {
        await dialog.showMessageBox(withMainWindow() || undefined, {
          type: "info",
          title: "No Updates Found",
          message: `You are already using the latest version (${currentVersion}).`,
        });
      }

      return {
        ok: true,
        hasUpdate,
        currentVersion,
        availableVersion,
        message: hasUpdate
          ? `Update ${availableVersion} is available.`
          : `You are already on the latest version (${currentVersion}).`,
      };
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("manual update check failed:", error);
      return {
        ok: false,
        message: `Failed to check for updates: ${String(error)}`,
      };
    }
  });
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
      preload: resolveAppPath("desktop", "preload.js"),
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
    setupAutoUpdates();
  });

  void mainWindow.loadFile(indexPath);
};

const bootstrapDesktopApp = async () => {
  startBackend();
  await waitForBackend();
  setupDesktopIpc();
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
  closeUpdateProgress();
  if (process.platform !== "darwin") {
    app.quit();
  }
});
