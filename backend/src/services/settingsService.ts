import { MISTRAL_MODELS, MISTRAL_URLS, getMistralChatKeys, getMistralTranscribeKey } from "../config";
import type { AiProvider } from "../types";
import { getMongoDb } from "../utils/mongo";

const SETTINGS_COLLECTION = "app_settings";
const PROVIDER_SETTINGS_ID = "ai_provider_config";

export type ProviderSettings = {
  mistral: ProviderSettingsEntry;
  openai: ProviderSettingsEntry;
  saveToSheets: boolean;
  saveToBigQuery: boolean;
  updatedAt: string;
};

export type ProviderSettingsEntry = {
  apiKey: string;
  apiKey2: string;
  apiKey3: string;
  apiKey4: string;
  transcribeApiKey: string;
  chatEndpoint: string;
  ocrEndpoint: string;
  transcribeEndpoint: string;
  chatModel: string;
  ocrModel: string;
  transcribeModel: string;
};

export type ProviderRuntimeConfig = {
  provider: AiProvider;
  apiKey: string;
  rotationApiKeys: string[];
  transcribeApiKey: string;
  endpoints: {
    chat: string;
    ocr: string;
    transcribe: string;
  };
  models: {
    chat: string;
    ocr: string;
    transcribe: string;
  };
};

export type StorageSettings = {
  saveToSheets: boolean;
  saveToBigQuery: boolean;
};

type ProviderSettingsDocument = ProviderSettings & {
  _id: string;
  createdAt: string;
};

const nowIso = (): string => new Date().toISOString();

const OPENAI_DEFAULTS: ProviderSettingsEntry = {
  apiKey: process.env.OPENAI_API_KEY?.trim() ?? "",
  apiKey2: "",
  apiKey3: "",
  apiKey4: "",
  transcribeApiKey: "",
  chatEndpoint:
    process.env.OPENAI_CHAT_ENDPOINT?.trim() ?? "https://api.openai.com/v1/chat/completions",
  ocrEndpoint: process.env.OPENAI_OCR_ENDPOINT?.trim() ?? "https://api.openai.com/v1/chat/completions",
  transcribeEndpoint:
    process.env.OPENAI_TRANSCRIBE_ENDPOINT?.trim() ?? "https://api.openai.com/v1/audio/transcriptions",
  chatModel: process.env.OPENAI_CHAT_MODEL?.trim() ?? "gpt-4.1-mini",
  ocrModel: process.env.OPENAI_OCR_MODEL?.trim() ?? "gpt-4.1-mini",
  transcribeModel: process.env.OPENAI_TRANSCRIBE_MODEL?.trim() ?? "gpt-4o-mini-transcribe",
};

const MISTRAL_DEFAULTS: ProviderSettingsEntry = {
  apiKey:
    process.env.MISTRAL_API_KEY?.trim() ??
    getMistralChatKeys()[0]?.trim() ??
    getMistralTranscribeKey()?.trim() ??
    "",
  apiKey2: process.env.MISTRAL_API_KEY_2?.trim() ?? "",
  apiKey3: process.env.MISTRAL_API_KEY_3?.trim() ?? "",
  apiKey4: process.env.MISTRAL_API_KEY_4?.trim() ?? "",
  transcribeApiKey: process.env.MISTRAL_TRANSCRIBE_API_KEY?.trim() ?? "",
  chatEndpoint: MISTRAL_URLS.chat,
  ocrEndpoint: MISTRAL_URLS.ocr,
  transcribeEndpoint: MISTRAL_URLS.transcribe,
  chatModel: MISTRAL_MODELS.chat,
  ocrModel: MISTRAL_MODELS.ocr,
  transcribeModel: MISTRAL_MODELS.transcribe,
};

const normalizeString = (value: unknown, fallback = ""): string => {
  if (typeof value !== "string") {
    return fallback;
  }
  return value.trim();
};

const normalizeBoolean = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === "boolean") {
    return value;
  }
  return fallback;
};

const normalizeEntry = (value: unknown, fallback: ProviderSettingsEntry): ProviderSettingsEntry => {
  const source = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

  return {
    apiKey: normalizeString(source.apiKey, fallback.apiKey),
    apiKey2: normalizeString(source.apiKey2, fallback.apiKey2),
    apiKey3: normalizeString(source.apiKey3, fallback.apiKey3),
    apiKey4: normalizeString(source.apiKey4, fallback.apiKey4),
    transcribeApiKey: normalizeString(source.transcribeApiKey, fallback.transcribeApiKey),
    chatEndpoint: normalizeString(source.chatEndpoint, fallback.chatEndpoint),
    ocrEndpoint: normalizeString(source.ocrEndpoint, fallback.ocrEndpoint),
    transcribeEndpoint: normalizeString(source.transcribeEndpoint, fallback.transcribeEndpoint),
    chatModel: normalizeString(source.chatModel, fallback.chatModel),
    ocrModel: normalizeString(source.ocrModel, fallback.ocrModel),
    transcribeModel: normalizeString(source.transcribeModel, fallback.transcribeModel),
  };
};

const normalizeSettings = (value: unknown, defaults?: ProviderSettings): ProviderSettings => {
  const source = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const fallback: ProviderSettings = defaults ?? {
    mistral: { ...MISTRAL_DEFAULTS },
    openai: { ...OPENAI_DEFAULTS },
    saveToSheets: true,
    saveToBigQuery: true,
    updatedAt: nowIso(),
  };

  return {
    mistral: normalizeEntry(source.mistral, fallback.mistral),
    openai: normalizeEntry(source.openai, fallback.openai),
    saveToSheets: normalizeBoolean(source.saveToSheets, fallback.saveToSheets),
    saveToBigQuery: normalizeBoolean(source.saveToBigQuery, fallback.saveToBigQuery),
    updatedAt: normalizeString(source.updatedAt, fallback.updatedAt),
  };
};

const toPublicSettings = (document: ProviderSettingsDocument): ProviderSettings => ({
  mistral: document.mistral,
  openai: document.openai,
  saveToSheets: document.saveToSheets,
  saveToBigQuery: document.saveToBigQuery,
  updatedAt: document.updatedAt,
});

const defaultSettings = (): ProviderSettingsDocument => {
  const now = nowIso();
  return {
    _id: PROVIDER_SETTINGS_ID,
    mistral: { ...MISTRAL_DEFAULTS },
    openai: { ...OPENAI_DEFAULTS },
    saveToSheets: true,
    saveToBigQuery: true,
    createdAt: now,
    updatedAt: now,
  };
};

const getCollection = async () => {
  const db = await getMongoDb();
  return db.collection<ProviderSettingsDocument>(SETTINGS_COLLECTION);
};

export const getProviderSettings = async (): Promise<ProviderSettings> => {
  const collection = await getCollection();
  const existing = await collection.findOne({ _id: PROVIDER_SETTINGS_ID });

  if (!existing) {
    const created = defaultSettings();
    await collection.insertOne(created);
    return toPublicSettings(created);
  }

  const normalized = normalizeSettings(existing, toPublicSettings(existing));
  return normalized;
};

export const saveProviderSettings = async (input: unknown): Promise<ProviderSettings> => {
  const collection = await getCollection();
  const existing = await collection.findOne({ _id: PROVIDER_SETTINGS_ID });
  const current = existing ? toPublicSettings(existing) : toPublicSettings(defaultSettings());
  const normalized = normalizeSettings(input, current);
  const now = nowIso();

  const nextDocument: ProviderSettingsDocument = {
    _id: PROVIDER_SETTINGS_ID,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    mistral: normalized.mistral,
    openai: normalized.openai,
    saveToSheets: normalized.saveToSheets,
    saveToBigQuery: normalized.saveToBigQuery,
  };

  await collection.replaceOne({ _id: PROVIDER_SETTINGS_ID }, nextDocument, { upsert: true });

  return toPublicSettings(nextDocument);
};

export const getRuntimeProviderConfig = async (provider: AiProvider): Promise<ProviderRuntimeConfig> => {
  const settings = await getProviderSettings();
  const selected = settings[provider];

  if (!selected.apiKey.trim()) {
    throw new Error(`Missing ${provider.toUpperCase()} API key in settings.`);
  }

  const rotationApiKeys =
    provider === "mistral"
      ? [...new Set([selected.apiKey, selected.apiKey2, selected.apiKey3, selected.apiKey4].map((key) => key.trim()).filter((key) => key.length > 0))]
      : [selected.apiKey.trim()];

  const transcribeApiKey = selected.transcribeApiKey.trim() || selected.apiKey.trim();

  return {
    provider,
    apiKey: selected.apiKey.trim(),
    rotationApiKeys,
    transcribeApiKey,
    endpoints: {
      chat: selected.chatEndpoint,
      ocr: selected.ocrEndpoint,
      transcribe: selected.transcribeEndpoint,
    },
    models: {
      chat: selected.chatModel,
      ocr: selected.ocrModel,
      transcribe: selected.transcribeModel,
    },
  };
};

export const getStorageSettings = async (): Promise<StorageSettings> => {
  const settings = await getProviderSettings();
  return {
    saveToSheets: settings.saveToSheets,
    saveToBigQuery: settings.saveToBigQuery,
  };
};
