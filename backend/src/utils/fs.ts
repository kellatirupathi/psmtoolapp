import fs from "node:fs";
import path from "node:path";

export const ensureDir = (dirPath: string): void => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
};

export const ensureDirs = (dirs: string[]): void => {
  for (const dir of dirs) {
    ensureDir(dir);
  }
};

export const readTextFileIfExists = (filePath: string): string => {
  if (!fs.existsSync(filePath)) return "";
  return fs.readFileSync(filePath, "utf8");
};

export const writeTextFile = (filePath: string, content: string): void => {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, "utf8");
};

export const safeRemoveFile = (filePath: string): void => {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Ignore cleanup failures.
  }
};

export const safeRemoveDir = (dirPath: string): void => {
  try {
    if (fs.existsSync(dirPath)) fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
    // Ignore cleanup failures.
  }
};
