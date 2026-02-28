# PSM Analyser

React + Node/Express application with two delivery modes:

- Online web app (frontend + hosted backend)
- Downloadable desktop app (Electron + local backend runtime)

## Prerequisites

- Node.js 20+
- npm 10+

## Environment

Copy `.env.example` to `.env` and fill required values:

- `MONGODB_URL`
- provider credentials/settings source
- Google credentials if sheet export is enabled

## Online Development

Run frontend + backend:

```powershell
npm install
npm run dev
```

- Frontend: `http://localhost:3000`
- Backend: `http://localhost:4000`

## Desktop Runtime (Local App)

Run desktop app directly (without installer):

```powershell
npm run desktop:start
```

This command builds:

- React client with API base `http://127.0.0.1:4000/api`
- Backend TypeScript output in `backend/dist`
- Electron shell that starts local backend and opens desktop UI

Desktop runtime can load overrides from `desktop/desktop.env` (template: `desktop/desktop.env.example`), including `MONGODB_URL`.

## Desktop Installer Packaging

Build Windows installer:

```powershell
npm run desktop:package:win
```

Installer output:

```text
desktop/releases/PSM-Analyser-Setup-<version>.exe
```

## "Download Desktop App" Button in Web UI

The sidebar button reads URL from:

- backend `DESKTOP_DOWNLOAD_URL` (preferred), or
- frontend build-time fallback `REACT_APP_DESKTOP_DOWNLOAD_URL`

If `DESKTOP_DOWNLOAD_URL` points to `/downloads/...`, backend serves files from:

```text
desktop/releases
```

## Typecheck and Build

```powershell
npm run typecheck
npm run build
npm run build:server
```
