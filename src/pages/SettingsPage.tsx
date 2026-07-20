import { useEffect, useMemo, useState } from "react";
import { fetchProviderSettings, saveProviderSettings } from "../api/client";
import type { ProviderSettings, ProviderSettingsEntry } from "../types";

const GEMINI_GENERATE_CONTENT_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent";

const defaultEntry = (entry: Partial<ProviderSettingsEntry> = {}): ProviderSettingsEntry => ({
  apiKey: entry.apiKey ?? "",
  transcribeApiKey: entry.transcribeApiKey ?? "",
  chatEndpoint: entry.chatEndpoint ?? "",
  ocrEndpoint: entry.ocrEndpoint ?? "",
  transcribeEndpoint: entry.transcribeEndpoint ?? "",
  chatModel: entry.chatModel ?? "",
  ocrModel: entry.ocrModel ?? "",
  transcribeModel: entry.transcribeModel ?? "",
});

const defaultSettings: ProviderSettings = {
  openai: defaultEntry({
    chatEndpoint: "https://api.openai.com/v1/chat/completions",
    ocrEndpoint: "https://api.openai.com/v1/chat/completions",
    transcribeEndpoint: "https://api.openai.com/v1/audio/transcriptions",
    chatModel: "gpt-4.1-mini",
    ocrModel: "gpt-4.1-mini",
    transcribeModel: "gpt-4o-transcribe",
  }),
  gemini: defaultEntry({
    chatEndpoint: GEMINI_GENERATE_CONTENT_ENDPOINT,
    ocrEndpoint: GEMINI_GENERATE_CONTENT_ENDPOINT,
    transcribeEndpoint: GEMINI_GENERATE_CONTENT_ENDPOINT,
    chatModel: "gemini-3.1-flash-lite",
    ocrModel: "gemini-3.1-flash-lite",
    transcribeModel: "gemini-3.5-flash",
  }),
  transcriptionProvider: "gemini",
  qnaProvider: "gemini",
  saveToSheets: true,
  saveToBigQuery: true,
  updatedAt: "",
};

type ProviderKey = "openai" | "gemini";

export function SettingsPage() {
  const [settings, setSettings] = useState<ProviderSettings>(defaultSettings);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [checkingForUpdates, setCheckingForUpdates] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<string | null>(null);
  const canCheckForUpdates = useMemo(
    () => typeof window !== "undefined" && typeof window.desktopUpdater?.checkForUpdates === "function",
    [],
  );

  useEffect(() => {
    const load = async (): Promise<void> => {
      try {
        setLoading(true);
        setError(null);
        setSettings(await fetchProviderSettings());
      } catch (err) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, []);

  const updateField = (
    provider: ProviderKey,
    field: keyof ProviderSettingsEntry,
    value: string,
  ): void => {
    setSettings((prev) => ({
      ...prev,
      [provider]: { ...prev[provider], [field]: value },
    }));
  };

  const updateStorageToggle = (field: "saveToSheets" | "saveToBigQuery", value: boolean): void => {
    setSettings((prev) => ({ ...prev, [field]: value }));
  };

  const updateInterviewProvider = (
    field: "transcriptionProvider" | "qnaProvider",
    value: ProviderKey,
  ): void => {
    setSettings((prev) => ({ ...prev, [field]: value }));
  };

  const save = async (): Promise<void> => {
    try {
      setSaving(true);
      setError(null);
      setSuccess(null);
      setSettings(await saveProviderSettings(settings));
      setSuccess("Settings saved.");
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const checkForUpdates = async (): Promise<void> => {
    if (!canCheckForUpdates || !window.desktopUpdater) return;
    try {
      setCheckingForUpdates(true);
      setUpdateError(null);
      setUpdateStatus(null);
      const result = await window.desktopUpdater.checkForUpdates();
      if (!result.ok) {
        setUpdateError(result.message);
        return;
      }
      setUpdateStatus(result.message);
    } catch (err) {
      setUpdateError(String(err));
    } finally {
      setCheckingForUpdates(false);
    }
  };

  const renderProviderCard = (provider: ProviderKey, title: string) => {
    const entry = settings[provider];
    const isGemini = provider === "gemini";
    return (
      <section className="provider-card">
        <h4>{title}</h4>
        <label>
          API Key
          <input
            type="password"
            autoComplete="new-password"
            value={entry.apiKey}
            onChange={(event) => updateField(provider, "apiKey", event.target.value)}
          />
        </label>
        <label>
          Transcribe API Key <span className="muted">(optional — falls back to API Key)</span>
          <input
            type="password"
            autoComplete="new-password"
            value={entry.transcribeApiKey}
            onChange={(event) => updateField(provider, "transcribeApiKey", event.target.value)}
          />
        </label>
        <label>
          {isGemini ? "Q&A Generate Content Endpoint" : "Chat Endpoint"}
          <input
            type="text"
            value={entry.chatEndpoint}
            onChange={(event) => updateField(provider, "chatEndpoint", event.target.value)}
          />
        </label>
        {!isGemini && (
          <label>
            OCR Endpoint
            <input
              type="text"
              value={entry.ocrEndpoint}
              onChange={(event) => updateField(provider, "ocrEndpoint", event.target.value)}
            />
          </label>
        )}
        <label>
          {isGemini ? "Audio Generate Content Endpoint" : "Transcribe Endpoint"}
          <input
            type="text"
            value={entry.transcribeEndpoint}
            onChange={(event) => updateField(provider, "transcribeEndpoint", event.target.value)}
          />
        </label>
        <label>
          {isGemini ? "Q&A Model" : "Chat Model"}
          <input
            type="text"
            value={entry.chatModel}
            onChange={(event) => updateField(provider, "chatModel", event.target.value)}
          />
        </label>
        {!isGemini && (
          <label>
            OCR Model
            <input
              type="text"
              value={entry.ocrModel}
              onChange={(event) => updateField(provider, "ocrModel", event.target.value)}
            />
          </label>
        )}
        <label>
          {isGemini ? "Audio Transcription Model" : "Transcribe Model"}
          <input
            type="text"
            value={entry.transcribeModel}
            onChange={(event) => updateField(provider, "transcribeModel", event.target.value)}
          />
        </label>
      </section>
    );
  };

  return (
    <div className="page-section">
      <section className="panel">
        <h3>Settings</h3>
        <p className="muted">
          Configure global AI credentials and select providers independently for interview transcription and Q&A.
        </p>
        <div className="inline-controls">
          <label>
            <input
              type="checkbox"
              checked={settings.saveToSheets}
              onChange={(event) => updateStorageToggle("saveToSheets", event.target.checked)}
            />
            Save outputs to Sheets
          </label>
          <label>
            <input
              type="checkbox"
              checked={settings.saveToBigQuery}
              onChange={(event) => updateStorageToggle("saveToBigQuery", event.target.checked)}
            />
            Save outputs to BigQuery
          </label>
        </div>

        <div className="provider-routing-grid">
          <label>
            Interview audio transcription provider
            <select
              value={settings.transcriptionProvider}
              onChange={(event) => updateInterviewProvider(
                "transcriptionProvider",
                event.target.value as ProviderKey,
              )}
            >
              <option value="gemini">Gemini</option>
              <option value="openai">OpenAI</option>
            </select>
          </label>
          <label>
            Interview Q&A provider
            <select
              value={settings.qnaProvider}
              onChange={(event) => updateInterviewProvider(
                "qnaProvider",
                event.target.value as ProviderKey,
              )}
            >
              <option value="gemini">Gemini</option>
              <option value="openai">OpenAI</option>
            </select>
          </label>
        </div>

        <div className="settings-grid">
          {renderProviderCard("openai", "OpenAI")}
          {renderProviderCard("gemini", "Gemini")}
        </div>

        <div className="button-row">
          <button className="primary-button" onClick={() => void save()} disabled={saving || loading}>
            {saving ? "Saving..." : "Save Settings"}
          </button>
          {canCheckForUpdates && (
            <button
              className="secondary-button"
              onClick={() => void checkForUpdates()}
              disabled={checkingForUpdates || saving || loading}
            >
              {checkingForUpdates ? "Checking..." : "Check for Updates"}
            </button>
          )}
          {loading && <span className="muted">Loading settings...</span>}
          {settings.updatedAt && !loading && (
            <span className="muted">Last updated: {new Date(settings.updatedAt).toLocaleString()}</span>
          )}
        </div>

        {success && <div className="live-status-line">{success}</div>}
        {error && <div className="error-box">{error}</div>}
        {updateStatus && <div className="live-status-line">{updateStatus}</div>}
        {updateError && <div className="error-box">{updateError}</div>}
      </section>
    </div>
  );
}
