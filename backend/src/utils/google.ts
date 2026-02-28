import fs from "node:fs";
import path from "node:path";
import { google } from "googleapis";
import { GSHEET_ID, getSheetsServiceAccountCredentials } from "../config";
import { ensureDir } from "./fs";
import type { JobProgress } from "./jobManager";

const DEFAULT_SHEETS_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.readonly",
];

const DEFAULT_DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.readonly"];

const getAuthClient = (scopes: string[]) => {
  const credentials = getSheetsServiceAccountCredentials();
  if (!credentials) {
    return null;
  }

  return new google.auth.GoogleAuth({
    credentials,
    scopes,
  });
};

const getSheets = () => {
  const auth = getAuthClient(DEFAULT_SHEETS_SCOPES);
  if (!auth) return null;
  return google.sheets({ version: "v4", auth });
};

const getDrive = () => {
  const auth = getAuthClient(DEFAULT_DRIVE_SCOPES);
  if (!auth) return null;
  return google.drive({ version: "v3", auth });
};

const ensureSheetExists = async (sheets: ReturnType<typeof google.sheets>, sheetName: string): Promise<void> => {
  const metadata = await sheets.spreadsheets.get({ spreadsheetId: GSHEET_ID });
  const found = metadata.data.sheets?.some((sheet) => sheet.properties?.title === sheetName);

  if (found) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: GSHEET_ID,
    requestBody: {
      requests: [
        {
          addSheet: {
            properties: {
              title: sheetName,
            },
          },
        },
      ],
    },
  });
};

const normalizeRows = (rows: Record<string, unknown>[], headers: string[]): string[][] => {
  return rows.map((row) => headers.map((header) => String(row[header] ?? "N/A")));
};

const toPositiveNumber = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

export const appendRowsWithHeaders = async (args: {
  sheetName: string;
  headers: string[];
  rows: Record<string, unknown>[];
}): Promise<boolean> => {
  if (args.rows.length === 0) {
    return true;
  }

  const sheets = getSheets();
  if (!sheets) {
    return false;
  }

  try {
    await ensureSheetExists(sheets, args.sheetName);

    const headerRange = `${args.sheetName}!1:1`;
    const headerResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: GSHEET_ID,
      range: headerRange,
    });

    const currentHeaders = headerResponse.data.values?.[0] ?? [];
    const incomingHeaders = args.headers;
    const isHeaderExact =
      currentHeaders.length === incomingHeaders.length &&
      currentHeaders.every((header, index) => header === incomingHeaders[index]);

    if (!isHeaderExact) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: GSHEET_ID,
        range: `${args.sheetName}!A1`,
        valueInputOption: "RAW",
        requestBody: {
          values: [incomingHeaders],
        },
      });
    }

    const values = normalizeRows(args.rows, incomingHeaders);

    await sheets.spreadsheets.values.append({
      spreadsheetId: GSHEET_ID,
      range: `${args.sheetName}!A2`,
      valueInputOption: "RAW",
      requestBody: {
        values,
      },
    });

    return true;
  } catch {
    return false;
  }
};

type DownloadProgressCallback = (progress: JobProgress) => void;

export const downloadDriveFileToPath = async (
  fileId: string,
  outputPath: string,
  onProgress?: DownloadProgressCallback,
): Promise<string> => {
  const drive = getDrive();
  if (!drive) {
    return "Credentials Error";
  }

  try {
    ensureDir(path.dirname(outputPath));
    let totalBytes: number | null = null;

    try {
      const metadata = await drive.files.get({
        fileId,
        fields: "size",
        supportsAllDrives: true,
      });
      totalBytes = toPositiveNumber(metadata.data.size);
    } catch {
      totalBytes = null;
    }

    const response = await drive.files.get(
      {
        fileId,
        alt: "media",
        supportsAllDrives: true,
      },
      {
        responseType: "stream",
      },
    );

    if (!totalBytes) {
      const headerLength = response.headers?.["content-length"];
      totalBytes = Array.isArray(headerLength)
        ? toPositiveNumber(headerLength[0])
        : toPositiveNumber(headerLength);
    }

    let loadedBytes = 0;
    let lastEmittedPercent = -1;
    const emitProgress = (force = false): void => {
      if (!onProgress) return;
      const percent = totalBytes
        ? Math.min(100, Math.round((loadedBytes / totalBytes) * 100))
        : loadedBytes > 0
          ? 0
          : 0;

      if (!force && percent === lastEmittedPercent) {
        return;
      }

      lastEmittedPercent = percent;
      onProgress({
        percent,
        loadedBytes,
        totalBytes: totalBytes ?? undefined,
      });
    };

    emitProgress(true);

    await new Promise<void>((resolve, reject) => {
      const stream = fs.createWriteStream(outputPath);
      stream.on("error", (error: unknown) => reject(error));
      stream.on("finish", () => {
        if (totalBytes && loadedBytes < totalBytes) {
          loadedBytes = totalBytes;
        }
        emitProgress(true);
        resolve();
      });

      response.data
        .on("data", (chunk: Buffer) => {
          loadedBytes += chunk.length;
          emitProgress();
        })
        .on("error", (error: unknown) => reject(error))
        .pipe(stream);
    });

    return "Success";
  } catch (error) {
    const text = String(error);
    if (text.includes("File not found")) {
      return "File Not Found (Check Sharing)";
    }
    return text;
  }
};
