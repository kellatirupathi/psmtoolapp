import type { AiProvider } from "../types";

export const normalizeAiProvider = (value: unknown): AiProvider => {
  const normalized = String(value ?? "mistral").trim().toLowerCase();
  return normalized === "openai" ? "openai" : "mistral";
};
