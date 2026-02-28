import fs from "node:fs";
import path from "node:path";
import {
  MISTRAL_CHAT_MAX_RETRIES_PER_KEY,
  MISTRAL_CHAT_MIN_INTERVAL_SECONDS,
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

let lastMistralChatCallTs = 0;

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

const throttleMistralChat = async (): Promise<void> => {
  const now = Date.now();
  const elapsed = (now - lastMistralChatCallTs) / 1000;
  const waitSeconds = MISTRAL_CHAT_MIN_INTERVAL_SECONDS - elapsed;
  if (waitSeconds > 0) {
    await sleep(waitSeconds * 1000);
  }
  lastMistralChatCallTs = Date.now();
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
): Promise<any> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(runtime.endpoints.chat, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${runtime.apiKey}`,
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

  const maxRetries = options.maxRetries ?? MISTRAL_CHAT_MAX_RETRIES_PER_KEY;
  const timeoutMs = options.timeoutMs ?? 120000;
  let lastError: unknown = new Error("Unknown AI chat error");

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      if (runtime.provider === "mistral") {
        await throttleMistralChat();
      }
      const json = await executeChatRequest(runtime, payload, timeoutMs);
      return extractChatContent(json);
    } catch (error) {
      lastError = error;
      const status = Number((error as any)?.status ?? 0);
      if (!isRetriableStatus(status) || attempt >= maxRetries - 1) {
        break;
      }
      const waitSeconds = computeRetryWaitSeconds(attempt, (error as any)?.retryAfter);
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
    try {
      const response = await fetch(runtime.endpoints.ocr, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${runtime.apiKey}`,
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

      if (!response.ok) {
        return { fullText: "", imageIds: [] };
      }

      return parseOcrFromMistral(await response.json());
    } catch {
      return { fullText: "", imageIds: [] };
    }
  }

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

    if (!response.ok) {
      return { fullText: "", imageIds: [] };
    }

    return parseOcrFromOpenAi(await response.json());
  } catch {
    return { fullText: "", imageIds: [] };
  }
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
  const form = buildTranscriptionForm({
    fileName,
    audioBlob,
    model: runtime.models.transcribe,
    responseFormat: primaryFormat,
  });
  const transcribeApiKey = runtime.transcribeApiKey || runtime.apiKey;

  const response = await fetch(runtime.endpoints.transcribe, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${transcribeApiKey}`,
    },
    body: form,
  });

  if (!response.ok) {
    const fallbackForm = buildTranscriptionForm({
      fileName,
      audioBlob,
      model: runtime.models.transcribe,
      responseFormat: fallbackFormat,
    });

    const fallbackResponse = await fetch(runtime.endpoints.transcribe, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${transcribeApiKey}`,
      },
      body: fallbackForm,
    });

    if (!fallbackResponse.ok) {
      const text = await fallbackResponse.text();
      throw new Error(`Transcription failed: ${fallbackResponse.status} ${text}`);
    }

    return parseTranscriptionResponse(fallbackResponse, fallbackFormat);
  }

  return parseTranscriptionResponse(response, primaryFormat);
};
