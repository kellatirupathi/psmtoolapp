## Desktop Packaging

This project supports a downloadable desktop app (Electron) that runs:

- React UI locally
- Express backend locally
- Processing artifacts in a local writable folder
- Runtime settings from the same MongoDB instance

### Desktop Runtime Config (`desktop.env`)

If installer users should connect to shared MongoDB/settings, provide a `desktop.env` file
with at least:

```text
MONGODB_URL=...
MONGODB_DB_NAME=...
```

Supported locations:

- `%APPDATA%/<AppName>/desktop.env` (user override)
- `<app-install>/resources/app.asar/desktop/desktop.env` (packaged default)

Template file: `desktop/desktop.env.example`

### Build Desktop Installer (Windows)

```powershell
npm install
npm run desktop:package:win
```

Output installer:

```text
desktop/releases/PSM-Analyser-Setup-<version>.exe
```

### Quick Local Desktop Run (without installer)

```powershell
npm install
npm run desktop:start
```

This builds frontend/backend and launches Electron directly.

### Publish Download Link in Web UI

1. Place the generated installer under `desktop/releases`.
2. Set `DESKTOP_DOWNLOAD_URL` in backend environment.
   - Example: `/downloads/PSM-Analyser-Setup-0.1.0.exe`
3. Restart backend.

When `DESKTOP_DOWNLOAD_URL` is set, the sidebar shows **Download Desktop App**.
