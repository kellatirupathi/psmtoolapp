const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const sourceEnvPath = path.join(rootDir, ".env");
const fallbackEnvPath = path.join(rootDir, "desktop", "desktop.env.example");
const outputEnvPath = path.join(rootDir, "desktop", "desktop.env");

const GENERATED_HEADER = [
  "# Auto-generated for desktop installer packaging.",
  "# Source priority: .env (preferred) then desktop/desktop.env.example.",
  "# This file is bundled inside the desktop app and copied to userData on first launch.",
  "",
].join("\n");

const readEnvSource = () => {
  if (fs.existsSync(sourceEnvPath)) {
    return {
      sourcePath: sourceEnvPath,
      content: fs.readFileSync(sourceEnvPath, "utf8"),
    };
  }

  if (fs.existsSync(fallbackEnvPath)) {
    return {
      sourcePath: fallbackEnvPath,
      content: fs.readFileSync(fallbackEnvPath, "utf8"),
    };
  }

  return null;
};

const source = readEnvSource();
if (!source) {
  console.error("No env source found. Expected .env or desktop/desktop.env.example.");
  process.exit(1);
}

// Strip developer-machine specifics that would leak into end-user installers.
// - GCP_BIGQUERY_SERVICE_ACCOUNT_FILE pointing at an absolute path on the dev box:
//   desktop/main.js resolves the bundled kossip-helpers.json at runtime instead.
// - Stray TOML-style section headers (e.g. "[gcp_service_account]") that are
//   no-ops for the dotenv parser but confuse readers.
const sanitizeEnvForDesktop = (content) =>
  content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (/^\[[^\]]+\]\s*$/.test(trimmed)) return false;
      if (/^GCP_BIGQUERY_SERVICE_ACCOUNT_FILE\s*=\s*[A-Za-z]:[\\/]/i.test(trimmed)) return false;
      if (/^GCP_BIGQUERY_SERVICE_ACCOUNT_FILE\s*=\s*\/(home|Users)/i.test(trimmed)) return false;
      return true;
    })
    .join("\n")
    .trim();

const normalizedContent = sanitizeEnvForDesktop(source.content);
const output = `${GENERATED_HEADER}${normalizedContent}\n`;

fs.writeFileSync(outputEnvPath, output, "utf8");
console.log(`Prepared desktop default env from: ${source.sourcePath}`);
console.log(`Wrote: ${outputEnvPath}`);
