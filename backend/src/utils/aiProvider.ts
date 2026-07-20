import fs from "node:fs";
import path from "node:path";
import {
  OPENAI_CHAT_MAX_RETRIES,
  OPENAI_OCR_MAX_BACKOFF_SECONDS,
  OPENAI_OCR_MAX_RETRIES,
  OPENAI_TRANSCRIBE_MAX_BACKOFF_SECONDS,
  OPENAI_TRANSCRIBE_MAX_RETRIES,
} from "../config";
import type { ProviderRuntimeConfig } from "../services/settingsService";

export type AiChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type ChatOptions = {
  temperature?: number;
  responseAsJsonObject?: boolean;
  responseJsonSchema?: {
    name: string;
    description?: string;
    schema: Record<string, unknown>;
  };
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

// Default per-request ceiling for OCR/transcription HTTP calls. Without an
// abort signal a stalled connection never settles and the retry loop never
// fires, so the job hangs forever. OpenAI transcription of a large chunk can
// legitimately take a while, so the ceiling is generous.
const OCR_TIMEOUT_MS = Number(process.env.OPENAI_OCR_TIMEOUT_MS ?? 120000);
const TRANSCRIBE_TIMEOUT_MS = Number(process.env.OPENAI_TRANSCRIBE_TIMEOUT_MS ?? 300000);

const fetchWithTimeout = async (
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
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

const extractGeminiContent = (responseJson: any): string => {
  const parts = responseJson?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
    .filter((text: string) => text.length > 0)
    .join("\n");
};

const resolveGeminiModelEndpoint = (endpoint: string, model: string): string => {
  const trimmed = endpoint.trim();
  if (!trimmed) {
    throw new Error("Missing GEMINI endpoint in settings.");
  }
  if (trimmed.includes("{model}")) {
    return trimmed.replaceAll("{model}", encodeURIComponent(model));
  }
  if (/:(?:generateContent|streamGenerateContent)(?:\?|$)/i.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed.replace(/\/$/, "")}/${encodeURIComponent(model)}:generateContent`;
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
    const isGemini = runtime.provider === "gemini";
    const endpoint = isGemini
      ? resolveGeminiModelEndpoint(runtime.endpoints.chat, runtime.models.chat)
      : runtime.endpoints.chat;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: isGemini
        ? {
            "x-goog-api-key": apiKey,
            "Content-Type": "application/json",
            Accept: "application/json",
          }
        : {
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
  const isGemini = runtime.provider === "gemini";
  const payload: Record<string, unknown> = isGemini
    ? {
        systemInstruction: {
          parts: messages
            .filter((message) => message.role === "system")
            .map((message) => ({ text: message.content })),
        },
        contents: messages
          .filter((message) => message.role !== "system")
          .map((message) => ({
            role: message.role === "assistant" ? "model" : "user",
            parts: [{ text: message.content }],
          })),
        generationConfig: {
          temperature: options.temperature ?? 0.1,
          ...(options.responseJsonSchema
            ? {
                responseMimeType: "application/json",
                responseJsonSchema: options.responseJsonSchema.schema,
              }
            : options.responseAsJsonObject
              ? { responseMimeType: "application/json" }
              : {}),
        },
      }
    : {
        model: runtime.models.chat,
        messages,
        temperature: options.temperature ?? 0.1,
      };

  if (!isGemini && options.responseJsonSchema) {
    payload.response_format = {
      type: "json_schema",
      json_schema: {
        name: options.responseJsonSchema.name,
        description: options.responseJsonSchema.description,
        strict: true,
        schema: options.responseJsonSchema.schema,
      },
    };
  } else if (!isGemini && options.responseAsJsonObject) {
    payload.response_format = { type: "json_object" };
  }

  const timeoutMs = options.timeoutMs ?? 120000;
  const totalAttempts = options.maxRetries ?? OPENAI_CHAT_MAX_RETRIES;

  let lastError: unknown = new Error("Unknown AI chat error");

  for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
    try {
      const json = await executeChatRequest(runtime, payload, timeoutMs, runtime.apiKey);
      const content = isGemini ? extractGeminiContent(json) : extractChatContent(json);
      if (!content.trim()) {
        const blockReason = json?.promptFeedback?.blockReason ?? json?.candidates?.[0]?.finishReason;
        throw new Error(
          blockReason
            ? `Empty model response (${String(blockReason)}).`
            : "Empty model response.",
        );
      }
      return content;
    } catch (error) {
      lastError = error;
      const status = Number((error as any)?.status ?? 0);
      const isRetriable = isRetriableStatus(status);
      // 401/403/400 are not retriable; bail immediately.
      if (!isRetriable || attempt >= totalAttempts - 1) {
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
  const dataUrl = `data:${mimeType};base64,${base64}`;

  // OpenAI chat-completions accepts PDFs only as a `file` content part
  // (file_data data URL); images go through `image_url`. Using the wrong
  // part yields a 400, so branch on the mime type.
  const isPdf = mimeType === "application/pdf";
  const fileContentPart = isPdf
    ? {
        type: "file",
        file: {
          filename: path.basename(args.fileName) || "document.pdf",
          file_data: dataUrl,
        },
      }
    : {
        type: "image_url",
        image_url: {
          url: dataUrl,
        },
      };

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < OPENAI_OCR_MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetchWithTimeout(runtime.endpoints.ocr, {
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
                fileContentPart,
              ],
            },
          ],
        }),
      }, OCR_TIMEOUT_MS);

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

  return fetchWithTimeout(args.runtime.endpoints.transcribe, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.apiKey}`,
    },
    body: form,
  }, TRANSCRIBE_TIMEOUT_MS);
};

const GEMINI_TRANSCRIPTION_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    segments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          start_seconds: { type: "number" },
          end_seconds: { type: "number" },
          speaker: { type: "string" },
          text: { type: "string" },
        },
        required: ["start_seconds", "end_seconds", "speaker", "text"],
      },
    },
  },
  required: ["segments"],
};

const parseGeminiTranscription = (json: any): TranscriptionSegment[] => {
  const content = extractGeminiContent(json).trim();
  if (!content) {
    const reason = json?.promptFeedback?.blockReason ?? json?.candidates?.[0]?.finishReason;
    throw new Error(`Gemini transcription returned no content${reason ? ` (${String(reason)})` : ""}.`);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(content.replace(/```json/gi, "").replace(/```/g, "").trim());
  } catch (error) {
    throw new Error(`Gemini transcription returned invalid JSON: ${String(error)}`);
  }

  const segments = Array.isArray(parsed?.segments) ? parsed.segments : [];
  return segments
    .map((segment: any) => {
      const speaker = String(segment?.speaker ?? "Speaker").trim() || "Speaker";
      const text = String(segment?.text ?? "").trim();
      return {
        start: Math.max(0, Number(segment?.start_seconds ?? 0) || 0),
        end: Math.max(0, Number(segment?.end_seconds ?? 0) || 0),
        text: text ? `${speaker}: ${text}` : "",
      };
    })
    .filter((segment: TranscriptionSegment) => segment.text.length > 0);
};

const transcribeWithGemini = async (
  runtime: ProviderRuntimeConfig,
  audioBuffer: Buffer,
): Promise<TranscriptionSegment[]> => {
  const endpoint = resolveGeminiModelEndpoint(
    runtime.endpoints.transcribe,
    runtime.models.transcribe,
  );
  const payload = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text: [
              "Transcribe this interview audio faithfully and completely.",
              "Identify speakers consistently as Interviewer, Candidate, or Speaker N when uncertain.",
              "Return timestamps in seconds relative to the start of this audio chunk.",
              "Preserve the spoken language and technical terms. Do not translate, summarize, correct, or invent speech.",
              "Exclude only non-speech noise that contains no spoken information.",
            ].join(" "),
          },
          {
            inlineData: {
              mimeType: "audio/mpeg",
              data: audioBuffer.toString("base64"),
            },
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      responseJsonSchema: GEMINI_TRANSCRIPTION_SCHEMA,
    },
  };

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < OPENAI_TRANSCRIBE_MAX_RETRIES; attempt += 1) {
    const response = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers: {
        "x-goog-api-key": runtime.transcribeApiKey || runtime.apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    }, TRANSCRIBE_TIMEOUT_MS);

    if (response.ok) {
      const segments = parseGeminiTranscription(await response.json());
      if (segments.length === 0) {
        throw new Error("Gemini transcription returned an empty segments array.");
      }
      return segments;
    }

    lastError = await formatTranscriptionError(response);
    const status = Number((lastError as any).status ?? 0);
    if (!isRetriableTranscriptionStatus(status) || attempt >= OPENAI_TRANSCRIBE_MAX_RETRIES - 1) {
      break;
    }
    await sleep(
      computeRetryWaitSeconds(
        attempt,
        (lastError as any).retryAfter,
        OPENAI_TRANSCRIBE_MAX_BACKOFF_SECONDS,
      ) * 1000,
    );
  }

  throw lastError ?? new Error("Gemini transcription failed.");
};

export const aiTranscribeAudio = async (
  runtime: ProviderRuntimeConfig,
  audioPath: string,
): Promise<TranscriptionSegment[]> => {
  if (!fs.existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }

  const audioBuffer = fs.readFileSync(audioPath);
  if (runtime.provider === "gemini") {
    return transcribeWithGemini(runtime, audioBuffer);
  }
  const audioBlob = new Blob([audioBuffer], { type: "audio/mpeg" });
  const fileName = path.basename(audioPath);
  const primaryFormat: TranscriptionResponseFormat = "json";
  const fallbackFormat: TranscriptionResponseFormat = "text";

  const apiKey = runtime.transcribeApiKey || runtime.apiKey;
  const maxRetries = OPENAI_TRANSCRIBE_MAX_RETRIES;
  const maxBackoff = OPENAI_TRANSCRIBE_MAX_BACKOFF_SECONDS;

  let primaryError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
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

  const fallbackResponse = await requestTranscription({
    runtime,
    fileName,
    audioBlob,
    responseFormat: fallbackFormat,
    apiKey,
  });

  if (!fallbackResponse.ok) {
    throw await formatTranscriptionError(fallbackResponse);
  }

  return parseTranscriptionResponse(fallbackResponse, fallbackFormat);
};
