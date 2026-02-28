import path from "node:path";
import { readTextFileIfExists } from "./fs";

const PROMPT_DIR = process.env.PROMPT_DIR?.trim() || path.resolve(process.cwd(), "backend", "prompts");

export const loadPromptFile = (fileName: string): string => {
  const fullPath = path.join(PROMPT_DIR, fileName);
  return readTextFileIfExists(fullPath).trim();
};

export const loadQnaPrompt = (): string => loadPromptFile("q&a.txt");
export const loadClassifyPromptTemplate = (): string => loadPromptFile("classify.txt");
