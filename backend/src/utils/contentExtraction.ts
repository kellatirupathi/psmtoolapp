import { load as loadHtml } from "cheerio";
import { PDFParse } from "pdf-parse";
import type { ProviderRuntimeConfig } from "../services/settingsService";
import { aiOcr } from "./aiProvider";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
};
const MIN_MEANINGFUL_TEXT_LENGTH = 50;

const extractGoogleFileId = (url: string): string | null => {
  const match = url.match(/(?:\/d\/|id=)([a-zA-Z0-9-_]+)/);
  return match?.[1] ?? null;
};

const stripHtml = (html: string): string => {
  const $ = loadHtml(html);
  $("script, style, nav, footer, noscript").remove();
  return $.text().replace(/\s+/g, " ").trim();
};

const hasMeaningfulText = (text: string): boolean => {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return false;
  if (normalized === "notion") return false;
  return normalized.length >= MIN_MEANINGFUL_TEXT_LENGTH;
};

const toJinaReaderUrl = (url: string): string => {
  const withoutProtocol = url.replace(/^https?:\/\//i, "");
  return `https://r.jina.ai/http://${withoutProtocol}`;
};

const stripJinaReaderPreamble = (text: string): string => {
  return text
    .replace(/^Published Time:\s.*$/m, "")
    .replace(/^Title:\s.*$/m, "")
    .replace(/^URL Source:\s.*$/m, "")
    .replace(/^Markdown Content:\s*/m, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

const parsePdfText = async (buffer: Buffer): Promise<string> => {
  try {
    const parser = new PDFParse({ data: buffer });
    const parsed = await parser.getText();
    await parser.destroy();
    return parsed.text?.trim() ?? "";
  } catch {
    return "";
  }
};

const extractTextWithFallback = async (
  buffer: Buffer,
  extension: string,
  runtime: ProviderRuntimeConfig,
): Promise<string> => {
  const normalizedExt = extension.toLowerCase();

  if (normalizedExt === "pdf") {
    const parsed = await parsePdfText(buffer);
    if (parsed.length >= 50) {
      return parsed;
    }

    const ocr = await aiOcr(runtime, {
      fileName: "assignment.pdf",
      fileBuffer: buffer,
      mimeType: "application/pdf",
    });
    return ocr.fullText;
  }

  if (["jpg", "jpeg", "png", "webp", "bmp", "tiff"].includes(normalizedExt)) {
    const ocr = await aiOcr(runtime, {
      fileName: `assignment.${normalizedExt}`,
      fileBuffer: buffer,
    });
    return ocr.fullText;
  }

  return buffer.toString("utf8");
};

const tryFetchText = async (url: string, runtime: ProviderRuntimeConfig): Promise<string> => {
  const response = await fetch(url, {
    headers: HEADERS,
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const buffer = Buffer.from(await response.arrayBuffer());

  if (contentType.includes("pdf")) {
    return extractTextWithFallback(buffer, "pdf", runtime);
  }

  if (contentType.includes("image")) {
    return extractTextWithFallback(buffer, "png", runtime);
  }

  if (contentType.includes("html")) {
    return stripHtml(buffer.toString("utf8"));
  }

  return buffer.toString("utf8");
};

const extractGooglePublicPdf = async (url: string, runtime: ProviderRuntimeConfig): Promise<string> => {
  const fileId = extractGoogleFileId(url);
  if (!fileId) {
    return "Error: Bad URL";
  }

  const downloadUrl = url.includes("document/d/")
    ? `https://docs.google.com/document/d/${fileId}/export?format=pdf`
    : `https://drive.google.com/uc?id=${fileId}&export=download`;

  try {
    return await tryFetchText(downloadUrl, runtime);
  } catch (error) {
    return `Public Access Error: ${String(error)}`;
  }
};

const extractSharepointContent = async (url: string, runtime: ProviderRuntimeConfig): Promise<string> => {
  const cleanUrl = url.split("?")[0];
  const downloadUrl = `${cleanUrl}?download=1`;

  try {
    return await tryFetchText(downloadUrl, runtime);
  } catch (error) {
    return `SharePoint Error: ${String(error)}`;
  }
};

const extractNotionContent = async (url: string, runtime: ProviderRuntimeConfig): Promise<string> => {
  try {
    const direct = await tryFetchText(url, runtime);
    if (hasMeaningfulText(direct)) {
      return direct;
    }
  } catch {
    // Fall through to reader fallback.
  }

  try {
    const readerRaw = await tryFetchText(toJinaReaderUrl(url), runtime);
    const readerText = stripJinaReaderPreamble(readerRaw);
    if (hasMeaningfulText(readerText)) {
      return readerText;
    }
    return "Notion Error: Public page content could not be extracted.";
  } catch (error) {
    return `Notion Error: ${String(error)}`;
  }
};

export const smartFetchContent = async (
  urlInput: string,
  runtime: ProviderRuntimeConfig,
): Promise<string> => {
  const url = urlInput.trim();
  if (!url) {
    return "Error: Empty URL";
  }

  const urlLower = url.toLowerCase();

  try {
    if (urlLower.includes("docs.google.com/document")) {
      return extractGooglePublicPdf(url, runtime);
    }

    if (urlLower.includes("drive.google.com")) {
      if (urlLower.includes("/folders/")) {
        return "Error: Drive Folders not supported.";
      }

      return extractGooglePublicPdf(url, runtime);
    }

    if (urlLower.includes("sharepoint.com") || urlLower.includes("1drv.ms")) {
      return extractSharepointContent(url, runtime);
    }

    if (urlLower.includes("notion.site") || urlLower.includes("notion.so")) {
      return extractNotionContent(url, runtime);
    }

    return tryFetchText(url, runtime);
  } catch (error) {
    return `Web Error: ${String(error)}`;
  }
};
