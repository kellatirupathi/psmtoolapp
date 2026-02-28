import fs from "node:fs";
import path from "node:path";
import {
  MISTRAL_CHAT_MAX_RETRIES_PER_KEY,
  MISTRAL_CHAT_MIN_INTERVAL_SECONDS,
  MISTRAL_MODELS,
  MISTRAL_URLS,
  getMistralChatKeys,
  getMistralTranscribeKey,
} from "../config";

export type MistralChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type ChatOptions = {
  temperature?: number;
  responseAsJsonObject?: boolean;
  maxRetriesPerKey?: number;
  timeoutMs?: number;
  apiKey?: string;
  allowKeyFallback?: boolean;
};

type OcrResult = {
  fullText: string;
  imageIds: string[];
};

type TranscriptionSegment = {
  start: number;
  end: number;
  text: string;
};

let chatKeyIndex = 0;
let lastChatCallTs = 0;

const parseMaybeJson = (input: string): unknown => {
  const cleaned = input.replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return cleaned;
  }
};

const computeRetryWaitSeconds = (attempt: number, retryAfterHeader?: string | null): number => {
  if (retryAfterHeader) {
    const parsed = Number(retryAfterHeader);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(parsed, 30);
    }
  }

  return Math.min(2 ** attempt + Math.random() * 0.7 + 0.2, 30);
};

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const throttleChat = async (): Promise<void> => {
  const now = Date.now();
  const elapsed = (now - lastChatCallTs) / 1000;
  const waitSeconds = MISTRAL_CHAT_MIN_INTERVAL_SECONDS - elapsed;
  if (waitSeconds > 0) {
    await sleep(waitSeconds * 1000);
  }
  lastChatCallTs = Date.now();
};

const getRotatedChatKeys = (): string[] => {
  const keys = getMistralChatKeys();
  if (keys.length === 0) return [];

  const rotated = [...keys];
  const offset = chatKeyIndex % keys.length;
  if (offset > 0) {
    rotated.push(...rotated.splice(0, offset));
  }

  chatKeyIndex += 1;
  return rotated;
};

const extractChatContent = (responseJson: any): string => {
  return responseJson?.choices?.[0]?.message?.content ?? "";
};

export const mistralChat = async (
  messages: MistralChatMessage[],
  options: ChatOptions = {},
): Promise<string> => {
  const explicitKey = options.apiKey?.trim();
  const configuredKeys = getMistralChatKeys();
  const keys = explicitKey
    ? options.allowKeyFallback === false
      ? [explicitKey]
      : [explicitKey, ...configuredKeys.filter((value) => value !== explicitKey)]
    : getRotatedChatKeys();

  if (keys.length === 0) {
    throw new Error("No Mistral API keys configured.");
  }

  const payload: Record<string, unknown> = {
    model: MISTRAL_MODELS.chat,
    messages,
    temperature: options.temperature ?? 0.1,
  };

  if (options.responseAsJsonObject) {
    payload.response_format = { type: "json_object" };
  }

  const maxRetriesPerKey = options.maxRetriesPerKey ?? MISTRAL_CHAT_MAX_RETRIES_PER_KEY;
  const timeoutMs = options.timeoutMs ?? 120000;

  let lastError: unknown = new Error("Unknown Mistral error");

  for (const key of keys) {
    for (let attempt = 0; attempt < maxRetriesPerKey; attempt += 1) {
      try {
        await throttleChat();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetch(MISTRAL_URLS.chat, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if ([429, 500, 502, 503, 504].includes(response.status)) {
          const waitSeconds = computeRetryWaitSeconds(attempt, response.headers.get("Retry-After"));
          await sleep(waitSeconds * 1000);
          lastError = new Error(`${response.status} ${response.statusText}`);
          continue;
        }

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`${response.status}: ${text}`);
        }

        const json = await response.json();
        return extractChatContent(json);
      } catch (error) {
        lastError = error;
        if (attempt < maxRetriesPerKey - 1) {
          const waitSeconds = computeRetryWaitSeconds(attempt);
          await sleep(waitSeconds * 1000);
          continue;
        }
      }
    }
  }

  throw new Error(`Mistral chat failed after retries: ${String(lastError)}`);
};

export const mistralChatJson = async (
  messages: MistralChatMessage[],
  options: ChatOptions = {},
): Promise<unknown> => {
  const content = await mistralChat(messages, {
    ...options,
    responseAsJsonObject: options.responseAsJsonObject ?? true,
  });

  return parseMaybeJson(content);
};

export const mistralJsonAsArray = async (
  messages: MistralChatMessage[],
  options: ChatOptions = {},
): Promise<Record<string, unknown>[]> => {
  const parsed = await mistralChatJson(messages, options);

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

export const mistralOcr = async (args: {
  fileName: string;
  fileBuffer: Buffer;
  mimeType?: string;
}): Promise<OcrResult> => {
  const keys = getRotatedChatKeys();
  if (keys.length === 0) {
    return { fullText: "", imageIds: [] };
  }

  const mimeType = args.mimeType ?? mimeFromExtension(args.fileName);
  const base64 = args.fileBuffer.toString("base64");

  for (const key of keys) {
    try {
      const response = await fetch(MISTRAL_URLS.ocr, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MISTRAL_MODELS.ocr,
          document: {
            type: "image_url",
            image_url: `data:${mimeType};base64,${base64}`,
          },
          include_image_base64: false,
        }),
      });

      if (!response.ok) {
        continue;
      }

      const json: any = await response.json();
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
    } catch {
      // Try next key.
    }
  }

  return { fullText: "", imageIds: [] };
};

export const mistralTranscribeAudio = async (audioPath: string): Promise<TranscriptionSegment[]> => {
  const key = getMistralTranscribeKey();
  if (!key) {
    throw new Error("No Mistral transcribe key configured.");
  }

  if (!fs.existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }

  const form = new FormData();
  const audioBuffer = fs.readFileSync(audioPath);
  const audioBlob = new Blob([audioBuffer], { type: "audio/mpeg" });

  form.append("file", audioBlob, path.basename(audioPath));
  form.append("model", MISTRAL_MODELS.transcribe);
  form.append("timestamp_granularities", "segment");
  form.append("response_format", "verbose_json");

  const response = await fetch(MISTRAL_URLS.transcribe, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
    },
    body: form,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Transcription failed: ${response.status} ${text}`);
  }

  const json: any = await response.json();
  const segments = Array.isArray(json?.segments) ? json.segments : [];

  return segments
    .map((segment: any) => ({
      start: Number(segment?.start ?? 0),
      end: Number(segment?.end ?? 0),
      text: String(segment?.text ?? "").trim(),
    }))
    .filter((segment: TranscriptionSegment) => segment.text.length > 0);
};
