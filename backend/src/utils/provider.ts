import type { AiProvider } from "../types";

// OpenAI is the only supported provider. This normalizer is kept so existing
// callers (routes/services that forward a request-supplied provider value)
// continue to compile and always resolve to OpenAI.
export const normalizeAiProvider = (_value?: unknown): AiProvider => {
  return "openai";
};
