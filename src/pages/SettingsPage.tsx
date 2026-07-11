import { useEffect, useMemo, useState } from "react";
import { fetchProviderSettings, saveProviderSettings } from "../api/client";
import type { ProviderSettings, ProviderSettingsEntry } from "../types";

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
  saveToSheets: true,
  saveToBigQuery: true,
  updatedAt: "",
};

type ProviderKey = "openai";

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
        const remote = await fetchProviderSettings();
        setSettings(remote);
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
      [provider]: {
        ...prev[provider],
        [field]: value,
      },
    }));
  };

  const updateStorageToggle = (field: "saveToSheets" | "saveToBigQuery", value: boolean): void => {
    setSettings((prev) => ({
      ...prev,
      [field]: value,
    }));
  };

  const save = async (): Promise<void> => {
    try {
      setSaving(true);
      setError(null);
      setSuccess(null);
      const saved = await saveProviderSettings(settings);
      setSettings(saved);
      setSuccess("Settings saved.");
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const checkForUpdates = async (): Promise<void> => {
    if (!canCheckForUpdates || !window.desktopUpdater) {
      return;
    }

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
    return (
      <section className="provider-card">
        <h4>{title}</h4>
        <label>
          API Key
          <input
            type="text"
            value={entry.apiKey}
            onChange={(event) => updateField(provider, "apiKey", event.target.value)}
          />
        </label>
        <label>
          Transcribe API Key <span className="muted">(optional — falls back to API Key)</span>
          <input
            type="text"
            value={entry.transcribeApiKey}
            onChange={(event) => updateField(provider, "transcribeApiKey", event.target.value)}
          />
        </label>
        <label>
          Chat Endpoint
          <input
            type="text"
            value={entry.chatEndpoint}
            onChange={(event) => updateField(provider, "chatEndpoint", event.target.value)}
          />
        </label>
        <label>
          OCR Endpoint
          <input
            type="text"
            value={entry.ocrEndpoint}
            onChange={(event) => updateField(provider, "ocrEndpoint", event.target.value)}
          />
        </label>
        <label>
          Transcribe Endpoint
          <input
            type="text"
            value={entry.transcribeEndpoint}
            onChange={(event) => updateField(provider, "transcribeEndpoint", event.target.value)}
          />
        </label>
        <label>
          Chat Model
          <input
            type="text"
            value={entry.chatModel}
            onChange={(event) => updateField(provider, "chatModel", event.target.value)}
          />
        </label>
        <label>
          OCR Model
          <input
            type="text"
            value={entry.ocrModel}
            onChange={(event) => updateField(provider, "ocrModel", event.target.value)}
          />
        </label>
        <label>
          Transcribe Model
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
          Configure global AI provider credentials and endpoints for all users.
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
        <div className="settings-grid">
          {renderProviderCard("openai", "OpenAI")}
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
