import fs from "node:fs";
import path from "node:path";
import {
  MISTRAL_CHAT_MAX_RETRIES_PER_KEY,
  MISTRAL_CHAT_MIN_INTERVAL_SECONDS,
  MISTRAL_TRANSCRIBE_MAX_BACKOFF_SECONDS,
  MISTRAL_TRANSCRIBE_MAX_RETRIES,
  MISTRAL_TRANSCRIBE_MIN_INTERVAL_SECONDS,
  OPENAI_OCR_MAX_BACKOFF_SECONDS,
  OPENAI_OCR_MAX_RETRIES,
} from "../config";
import type { ProviderRuntimeConfig } from "../services/settingsService";

export type AiChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type ChatOptions = {
  temperature?: number;
  responseAsJsonObject?: boolean;
  maxRetries?: number;
  timeoutMs?: number;
};

export type OcrResult = {
  fullText: string;
  imageIds: string[];
};

export type TranscriptionSegment = {
  start: number;
  end: number;
  text: string;
};

type TranscriptionResponseFormat = "verbose_json" | "json" | "text";

const chatKeyLastCallTs: Map<string, number> = new Map();
const transcribeKeyLastCallTs: Map<string, number> = new Map();
const ocrKeyLastCallTs: Map<string, number> = new Map();

const parseMaybeJson = (input: string): unknown => {
  const cleaned = input.replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return cleaned;
  }
};

const computeRetryWaitSeconds = (
  attempt: number,
  retryAfterHeader?: string | null,
  maxSeconds = 30,
): number => {
  if (retryAfterHeader) {
    const parsed = Number(retryAfterHeader);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(parsed, maxSeconds);
    }
  }

  return Math.min(2 ** attempt + Math.random() * 0.7 + 0.2, maxSeconds);
};

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const throttleByKey = async (
  store: Map<string, number>,
  apiKey: string,
  minIntervalSeconds: number,
): Promise<void> => {
  const now = Date.now();
  const last = store.get(apiKey) ?? 0;
  const elapsed = (now - last) / 1000;
  const waitSeconds = minIntervalSeconds - elapsed;
  if (waitSeconds > 0) {
    await sleep(waitSeconds * 1000);
  }
  store.set(apiKey, Date.now());
};

const throttleMistralChatKey = async (apiKey: string): Promise<void> => {
  await throttleByKey(chatKeyLastCallTs, apiKey, MISTRAL_CHAT_MIN_INTERVAL_SECONDS);
};

const throttleMistralTranscribeKey = async (apiKey: string): Promise<void> => {
  await throttleByKey(transcribeKeyLastCallTs, apiKey, MISTRAL_TRANSCRIBE_MIN_INTERVAL_SECONDS);
};

const throttleMistralOcrKey = async (apiKey: string): Promise<void> => {
  await throttleByKey(ocrKeyLastCallTs, apiKey, MISTRAL_CHAT_MIN_INTERVAL_SECONDS);
};

const buildMistralKeyPool = (runtime: ProviderRuntimeConfig): string[] => {
  const seen = new Set<string>();
  const pool: string[] = [];
  const push = (raw: string | undefined): void => {
    const key = (raw ?? "").trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    pool.push(key);
  };

  for (const key of runtime.rotationApiKeys ?? []) {
    push(key);
  }
  push(runtime.apiKey);
  return pool.length > 0 ? pool : [runtime.apiKey];
};

const buildTranscribeKeyPool = (runtime: ProviderRuntimeConfig): string[] => {
  const seen = new Set<string>();
  const pool: string[] = [];
  const push = (raw: string | undefined): void => {
    const key = (raw ?? "").trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    pool.push(key);
  };

  push(runtime.transcribeApiKey);
  for (const key of buildMistralKeyPool(runtime)) {
    push(key);
  }
  return pool.length > 0 ? pool : [runtime.apiKey];
};

const extractChatContent = (responseJson: any): string => {
  const content = responseJson?.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item?.text === "string") {
          return item.text;
        }
        return "";
      })
      .filter((item) => item.length > 0)
      .join("\n");
  }

  return "";
};

const isRetriableStatus = (status: number): boolean => {
  return [429, 500, 502, 503, 504].includes(status);
};

const executeChatRequest = async (
  runtime: ProviderRuntimeConfig,
  payload: Record<string, unknown>,
  timeoutMs: number,
  apiKey: string,
): Promise<any> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(runtime.endpoints.chat, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const bodyText = await response.text();
      const error = new Error(`${response.status}: ${bodyText}`);
      (error as any).status = response.status;
      (error as any).retryAfter = response.headers.get("Retry-After");
      throw error;
    }

    return response.json();
  } finally {
    clearTimeout(timeout);
  }
};

export const aiChat = async (
  runtime: ProviderRuntimeConfig,
  messages: AiChatMessage[],
  options: ChatOptions = {},
): Promise<string> => {
  const payload: Record<string, unknown> = {
    model: runtime.models.chat,
    messages,
    temperature: options.temperature ?? 0.1,
  };

  if (options.responseAsJsonObject) {
    payload.response_format = { type: "json_object" };
  }

  const timeoutMs = options.timeoutMs ?? 120000;
  const keyPool = runtime.provider === "mistral"
    ? buildMistralKeyPool(runtime)
    : [runtime.apiKey];
  // Rotate across keys so free-tier 1 req/s per-key limits do not stall the
  // pipeline. Each key gets its own retry budget.
  const retriesPerKey = options.maxRetries ?? MISTRAL_CHAT_MAX_RETRIES_PER_KEY;
  const totalAttempts = Math.max(retriesPerKey, keyPool.length * retriesPerKey);

  let lastError: unknown = new Error("Unknown AI chat error");

  for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
    const apiKey = keyPool[attempt % keyPool.length];
    try {
      if (runtime.provider === "mistral") {
        await throttleMistralChatKey(apiKey);
      }
      const json = await executeChatRequest(runtime, payload, timeoutMs, apiKey);
      return extractChatContent(json);
    } catch (error) {
      lastError = error;
      const status = Number((error as any)?.status ?? 0);
      const isRetriable = isRetriableStatus(status);
      if (!isRetriable || attempt >= totalAttempts - 1) {
        // 401/403/400 are not retriable; bail immediately.
        if (!isRetriable) break;
        break;
      }
      const waitSeconds = computeRetryWaitSeconds(
        Math.floor(attempt / Math.max(keyPool.length, 1)),
        (error as any)?.retryAfter,
      );
      await sleep(waitSeconds * 1000);
    }
  }

  throw new Error(`${runtime.provider.toUpperCase()} chat failed after retries: ${String(lastError)}`);
};

export const aiChatJson = async (
  runtime: ProviderRuntimeConfig,
  messages: AiChatMessage[],
  options: ChatOptions = {},
): Promise<unknown> => {
  const content = await aiChat(runtime, messages, {
    ...options,
    responseAsJsonObject: options.responseAsJsonObject ?? true,
  });

  return parseMaybeJson(content);
};

export const aiJsonAsArray = async (
  runtime: ProviderRuntimeConfig,
  messages: AiChatMessage[],
  options: ChatOptions = {},
): Promise<Record<string, unknown>[]> => {
  const parsed = await aiChatJson(runtime, messages, options);

  if (Array.isArray(parsed)) {
    return parsed.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null);
  }

  if (typeof parsed === "object" && parsed !== null) {
    for (const value of Object.values(parsed)) {
      if (Array.isArray(value)) {
        return value.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null);
      }
    }

    return [parsed as Record<string, unknown>];
  }

  return [];
};

const mimeFromExtension = (fileName: string): string => {
  const ext = path.extname(fileName).toLowerCase();
  switch (ext) {
    case ".pdf":
      return "application/pdf";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".tiff":
      return "image/tiff";
    case ".bmp":
      return "image/bmp";
    default:
      return "application/octet-stream";
  }
};

const parseOcrFromMistral = (json: any): OcrResult => {
  const pages = Array.isArray(json?.pages) ? json.pages : [];
  const fullText = pages
    .map((page: any) => String(page?.markdown ?? ""))
    .join("\n\n")
    .trim();

  const imageIds = pages.flatMap((page: any) => {
    const images = Array.isArray(page?.images) ? page.images : [];
    return images.map((image: any) => String(image?.id ?? "unknown"));
  });

  return { fullText, imageIds };
};

const parseOcrFromOpenAi = (json: any): OcrResult => {
  const fullText = extractChatContent(json).trim();
  return { fullText, imageIds: [] };
};

export const aiOcr = async (runtime: ProviderRuntimeConfig, args: {
  fileName: string;
  fileBuffer: Buffer;
  mimeType?: string;
}): Promise<OcrResult> => {
  const mimeType = args.mimeType ?? mimeFromExtension(args.fileName);
  const base64 = args.fileBuffer.toString("base64");

  if (runtime.provider === "mistral") {
    const keyPool = buildMistralKeyPool(runtime);
    const maxRetries = Math.max(MISTRAL_CHAT_MAX_RETRIES_PER_KEY, keyPool.length);
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
      const apiKey = keyPool[attempt % keyPool.length];
      try {
        await throttleMistralOcrKey(apiKey);
        const response = await fetch(runtime.endpoints.ocr, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: runtime.models.ocr,
            document: {
              type: "image_url",
              image_url: `data:${mimeType};base64,${base64}`,
            },
            include_image_base64: false,
          }),
        });

        if (response.ok) {
          return parseOcrFromMistral(await response.json());
        }

        const bodyText = await response.text();
        lastError = new Error(`OCR ${response.status}: ${bodyText}`);
        (lastError as any).status = response.status;
        (lastError as any).retryAfter = response.headers.get("Retry-After");
        if (!isRetriableStatus(response.status) || attempt >= maxRetries - 1) {
          break;
        }
        const waitSeconds = computeRetryWaitSeconds(attempt, (lastError as any).retryAfter, 60);
        await sleep(waitSeconds * 1000);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt >= maxRetries - 1) break;
        await sleep(computeRetryWaitSeconds(attempt, null, 60) * 1000);
      }
    }

    throw new Error(`Mistral OCR failed after retries: ${String(lastError ?? "unknown error")}`);
  }

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < OPENAI_OCR_MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(runtime.endpoints.ocr, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${runtime.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: runtime.models.ocr,
          temperature: 0,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "Extract all visible text from this document. Return plain text only.",
                },
                {
                  type: "image_url",
                  image_url: {
                    url: `data:${mimeType};base64,${base64}`,
                  },
                },
              ],
            },
          ],
        }),
      });

      if (response.ok) {
        return parseOcrFromOpenAi(await response.json());
      }

      const bodyText = await response.text();
      lastError = new Error(`OpenAI OCR ${response.status}: ${bodyText}`);
      (lastError as any).status = response.status;
      (lastError as any).retryAfter = response.headers.get("Retry-After");
      if (!isRetriableStatus(response.status) || attempt >= OPENAI_OCR_MAX_RETRIES - 1) {
        break;
      }
      const waitSeconds = computeRetryWaitSeconds(
        attempt,
        (lastError as any).retryAfter,
        OPENAI_OCR_MAX_BACKOFF_SECONDS,
      );
      await sleep(waitSeconds * 1000);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt >= OPENAI_OCR_MAX_RETRIES - 1) break;
      await sleep(computeRetryWaitSeconds(attempt, null, OPENAI_OCR_MAX_BACKOFF_SECONDS) * 1000);
    }
  }

  throw new Error(`OpenAI OCR failed after retries: ${String(lastError ?? "unknown error")}`);
};

const parseTranscriptionSegments = (json: any): TranscriptionSegment[] => {
  const segments = Array.isArray(json?.segments) ? json.segments : [];
  if (segments.length > 0) {
    return segments
      .map((segment: any) => ({
        start: Number(segment?.start ?? 0),
        end: Number(segment?.end ?? 0),
        text: String(segment?.text ?? "").trim(),
      }))
      .filter((segment: TranscriptionSegment) => segment.text.length > 0);
  }

  const text = String(json?.text ?? "").trim();
  if (!text) {
    return [];
  }

  return [{ start: 0, end: 0, text }];
};

const parseTranscriptionResponse = async (
  response: Response,
  responseFormat: TranscriptionResponseFormat,
): Promise<TranscriptionSegment[]> => {
  if (responseFormat === "text") {
    const text = (await response.text()).trim();
    return text ? [{ start: 0, end: 0, text }] : [];
  }

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("application/json")) {
    return parseTranscriptionSegments(await response.json());
  }

  const raw = await response.text();
  try {
    return parseTranscriptionSegments(JSON.parse(raw));
  } catch {
    const text = raw.trim();
    return text ? [{ start: 0, end: 0, text }] : [];
  }
};

const buildTranscriptionForm = (args: {
  fileName: string;
  audioBlob: Blob;
  model: string;
  responseFormat: TranscriptionResponseFormat;
}): FormData => {
  const form = new FormData();
  form.append("file", args.audioBlob, args.fileName);
  form.append("model", args.model);
  form.append("response_format", args.responseFormat);
  if (args.responseFormat === "verbose_json") {
    form.append("timestamp_granularities[]", "segment");
  }
  return form;
};

const isRetriableTranscriptionStatus = (status: number): boolean => {
  return [429, 500, 502, 503, 504].includes(status);
};

const shouldTryFallbackTranscriptionFormat = (status: number): boolean => {
  return [400, 404, 415, 422].includes(status);
};

const formatTranscriptionError = async (response: Response): Promise<Error> => {
  const rawText = (await response.text()).trim();
  const retryAfter = response.headers.get("Retry-After");
  const suffix =
    response.status === 429
      ? `Rate limit exceeded for ${response.url || "the transcription provider"}. Wait a bit, reduce request volume, use another API key, or switch provider.${retryAfter ? ` Retry after: ${retryAfter}s.` : ""}`
      : rawText;

  const error = new Error(`Transcription failed: ${response.status} ${suffix}`);
  (error as any).status = response.status;
  (error as any).retryAfter = retryAfter;
  return error;
};

const requestTranscription = async (args: {
  runtime: ProviderRuntimeConfig;
  fileName: string;
  audioBlob: Blob;
  responseFormat: TranscriptionResponseFormat;
  apiKey: string;
}): Promise<Response> => {
  const form = buildTranscriptionForm({
    fileName: args.fileName,
    audioBlob: args.audioBlob,
    model: args.runtime.models.transcribe,
    responseFormat: args.responseFormat,
  });

  return fetch(args.runtime.endpoints.transcribe, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.apiKey}`,
    },
    body: form,
  });
};

export const aiTranscribeAudio = async (
  runtime: ProviderRuntimeConfig,
  audioPath: string,
): Promise<TranscriptionSegment[]> => {
  if (!fs.existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }

  const audioBuffer = fs.readFileSync(audioPath);
  const audioBlob = new Blob([audioBuffer], { type: "audio/mpeg" });
  const fileName = path.basename(audioPath);
  const primaryFormat: TranscriptionResponseFormat =
    runtime.provider === "openai" ? "json" : "verbose_json";
  const fallbackFormat: TranscriptionResponseFormat =
    runtime.provider === "openai" ? "text" : "json";

  const keyPool = runtime.provider === "mistral"
    ? buildTranscribeKeyPool(runtime)
    : [runtime.transcribeApiKey || runtime.apiKey];
  const maxRetries = runtime.provider === "mistral"
    ? Math.max(MISTRAL_TRANSCRIBE_MAX_RETRIES, keyPool.length)
    : 3;
  const maxBackoff = runtime.provider === "mistral"
    ? MISTRAL_TRANSCRIBE_MAX_BACKOFF_SECONDS
    : 30;

  let primaryError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const apiKey = keyPool[attempt % keyPool.length];
    if (runtime.provider === "mistral") {
      await throttleMistralTranscribeKey(apiKey);
    }

    const response = await requestTranscription({
      runtime,
      fileName,
      audioBlob,
      responseFormat: primaryFormat,
      apiKey,
    });

    if (response.ok) {
      return parseTranscriptionResponse(response, primaryFormat);
    }

    primaryError = await formatTranscriptionError(response);
    const status = Number((primaryError as any).status ?? 0);
    if (!isRetriableTranscriptionStatus(status) || attempt >= maxRetries - 1) {
      break;
    }

    const waitSeconds = computeRetryWaitSeconds(
      attempt,
      (primaryError as any).retryAfter,
      maxBackoff,
    );
    await sleep(waitSeconds * 1000);
  }

  const primaryStatus = Number((primaryError as any)?.status ?? 0);
  if (!shouldTryFallbackTranscriptionFormat(primaryStatus)) {
    throw primaryError ?? new Error("Transcription failed.");
  }

  const fallbackKey = keyPool[0];
  if (runtime.provider === "mistral") {
    await throttleMistralTranscribeKey(fallbackKey);
  }
  const fallbackResponse = await requestTranscription({
    runtime,
    fileName,
    audioBlob,
    responseFormat: fallbackFormat,
    apiKey: fallbackKey,
  });

  if (!fallbackResponse.ok) {
    throw await formatTranscriptionError(fallbackResponse);
  }

  return parseTranscriptionResponse(fallbackResponse, fallbackFormat);
};
