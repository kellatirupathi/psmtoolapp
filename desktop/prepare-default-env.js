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

const normalizedContent = source.content.replace(/\r\n/g, "\n").trim();
const output = `${GENERATED_HEADER}${normalizedContent}\n`;

fs.writeFileSync(outputEnvPath, output, "utf8");
console.log(`Prepared desktop default env from: ${source.sourcePath}`);
console.log(`Wrote: ${outputEnvPath}`);
