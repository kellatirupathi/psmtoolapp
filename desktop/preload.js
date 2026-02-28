const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopUpdater", {
  checkForUpdates: () => ipcRenderer.invoke("desktop-updater:check"),
});
