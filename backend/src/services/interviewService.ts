import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { APP_DIRS, BIGQUERY_TABLE_NAMES, QNA_CHUNK_OVERLAP, QNA_CHUNK_SIZE, SHEET_NAMES } from "../config";
import { getRuntimeProviderConfig, getStorageSettings, type ProviderRuntimeConfig } from "./settingsService";
import { getCurriculumSnippet } from "../utils/curriculum";
import { forceEnumFormat } from "../utils/enum";
import { ensureDirs, readTextFileIfExists, safeRemoveFile, writeTextFile } from "../utils/fs";
import { createPublicGist } from "../utils/gist";
import { appendRowsToBigQuery } from "../utils/bigquery";
import { appendRowsWithHeaders, downloadDriveFileToPath } from "../utils/google";
import type { JobProgress, JobUpdatePayload } from "../utils/jobManager";
import {
  checkFfmpegInstalled,
  cleanTranscriptHallucinations,
  extractAudioFile,
  extractAudioSegment,
  getMediaDuration,
  mistralSegmentsToCleanText,
  splitAudioIntoChunks,
  validateVideoFile,
} from "../utils/media";
import { aiChat, aiTranscribeAudio } from "../utils/aiProvider";
import { loadClassifyPromptTemplate, loadQnaPrompt } from "../utils/prompts";
import type { AiProvider, InterviewInputRow, QaItem, VideoUploaderMetadata } from "../types";

const SHEET_HEADERS = [
  "user_id",
  "full_name",
  "mobile_number",
  "job_id",
  "company_name",
  "question_text",
  "answer_text",
  "relevancy_score",
  "question_type",
  "tech_stacks",
  "topic",
  "sub_topic",
  "difficulty",
  "interview_round",
  "clip_start_time",
  "clip_end_time",
  "video_link",
  "transcript_link",
  "drive_file_id",
  "curriculum_coverage",
  "question_uid",
  "interview_date",
  "question_creation_datetime",
  "source_type",
  "product",
];

const CLASSIFY_FIELDS = [
  "question_type",
  "question_concept",
  "difficulty",
  "topic",
  "sub_topic",
  "relevancy_score",
  "curriculum_coverage",
] as const;

const nowDateTime = (): string => new Date().toISOString().slice(0, 19).replace("T", " ");

type InterviewAnalysisResult = {
  rows: Array<Record<string, string>>;
  savedToSheet: boolean;
  savedToBigQuery: boolean;
};
type StatusUpdateCallback = (message: string, payload?: JobUpdatePayload<InterviewAnalysisResult>) => void;
type ProcessInterviewRowResult = { rows: Array<Record<string, string>>; cleanupPaths: string[] };

const cleanupFiles = (paths: string[]): void => {
  const unique = [...new Set(paths.map((item) => item.trim()).filter((item) => item.length > 0))];
  for (const filePath of unique) {
    safeRemoveFile(filePath);
  }
};

const parseModelResultAsArray = (content: string): Record<string, unknown>[] => {
  const cleaned = content.replace(/```json/gi, "").replace(/```/g, "").trim();

  try {
    const parsed = JSON.parse(cleaned);
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
  } catch {
    return [];
  }
};

const getChatCompletion = async (
  runtime: ProviderRuntimeConfig,
  prompt: string,
  content: string,
): Promise<string> => {
  const response = await aiChat(
    runtime,
    [
      { role: "system", content: `${prompt} Return ONLY valid JSON. No markdown.` },
      { role: "user", content },
    ],
    { temperature: 0.1, timeoutMs: 120000 },
  );

  return response || "[]";
};

const deduplicateQna = (items: QaItem[]): QaItem[] => {
  const seen = new Set<string>();
  const unique: QaItem[] = [];

  for (const item of items) {
    const key = String(item.question_text ?? "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }

  return unique;
};

const mergeClassification = (original: QaItem[], classified: Array<Record<string, unknown>>): QaItem[] => {
  const index = new Map<string, Record<string, unknown>>();

  for (const item of classified) {
    const key = String(item.question_text ?? "").trim();
    if (key) index.set(key, item);
  }

  return original.map((item) => {
    const key = String(item.question_text ?? "").trim();
    const match = index.get(key) ?? {};
    const merged: QaItem = { ...item };

    for (const field of CLASSIFY_FIELDS) {
      if (match[field] !== undefined) {
        (merged as any)[field] = String(match[field]);
      }
    }

    for (const field of CLASSIFY_FIELDS) {
      if ((merged as any)[field] === undefined) {
        (merged as any)[field] = "N/A";
      }
    }

    return merged;
  });
};

const classifyQnaList = async (
  runtime: ProviderRuntimeConfig,
  qna: QaItem[],
  classifyPrompt: string,
  batchSize = 12,
  abortIfCancelled?: () => void,
): Promise<QaItem[]> => {
  if (qna.length === 0) return [];

  const classified: Array<Record<string, unknown>> = [];

  for (let index = 0; index < qna.length; index += batchSize) {
    abortIfCancelled?.();
    const batch = qna.slice(index, index + batchSize);
    const content = JSON.stringify(batch);
    const response = await getChatCompletion(runtime, classifyPrompt, content);
    abortIfCancelled?.();
    classified.push(...parseModelResultAsArray(response));
  }

  return mergeClassification(qna, classified);
};

const processLargeTranscriptWithOverlap = async (
  runtime: ProviderRuntimeConfig,
  transcript: string,
  prompt: string,
  chunkSize = 12000,
  overlap = 1000,
  abortIfCancelled?: () => void,
): Promise<QaItem[]> => {
  const extracted: QaItem[] = [];
  let start = 0;

  while (start < transcript.length) {
    abortIfCancelled?.();
    let end = Math.min(start + chunkSize, transcript.length);

    if (end < transcript.length) {
      const nextNewline = transcript.indexOf("\n", end);
      if (nextNewline !== -1 && nextNewline - end < 200) {
        end = nextNewline;
      }
    }

    const chunk = transcript.slice(start, end);
    const content = `Analyze this interview segment:\n\n${chunk}`;

    const response = await getChatCompletion(runtime, prompt, content);
    abortIfCancelled?.();
    const parsed = parseModelResultAsArray(response);

    for (const item of parsed) {
      extracted.push({
        question_text: String(item.question_text ?? ""),
        answer_text: String(item.answer_text ?? ""),
      });
    }

    start += chunkSize - overlap;
    if (start >= transcript.length) {
      break;
    }
  }

  return extracted;
};

const generateTranscript = async (
  runtime: ProviderRuntimeConfig,
  audioPath: string,
  outputPath: string,
  onStatus?: (message: string) => void,
  abortIfCancelled?: () => void,
): Promise<void> => {
  const chunks = splitAudioIntoChunks(audioPath);
  let offset = 0;
  let transcriptBuffer = "";
  const totalChunks = chunks.length;
  let chunkIndex = 0;

  for (const chunk of chunks) {
    abortIfCancelled?.();
    chunkIndex += 1;
    onStatus?.(`Generating transcript chunk ${chunkIndex}/${totalChunks}...`);
    const segments = await aiTranscribeAudio(runtime, chunk);
    abortIfCancelled?.();
    transcriptBuffer += `${mistralSegmentsToCleanText(segments, offset)}\n`;

    offset += getMediaDuration(chunk) ?? 0;

    if (chunk !== audioPath) {
      safeRemoveFile(chunk);
    }
  }

  const cleaned = cleanTranscriptHallucinations(transcriptBuffer.trim());
  writeTextFile(outputPath, cleaned);
};

const toPositiveNumber = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const downloadFetchResponseToPath = async (
  response: Response,
  outputPath: string,
  onProgress?: (progress: JobProgress) => void,
): Promise<boolean> => {
  if (!response.body) {
    return false;
  }

  const totalBytes = toPositiveNumber(response.headers.get("content-length"));
  let loadedBytes = 0;
  let lastPercent = -1;
  const emitProgress = (force = false): void => {
    if (!onProgress) return;
    const percent = totalBytes
      ? Math.min(100, Math.round((loadedBytes / totalBytes) * 100))
      : loadedBytes > 0
        ? 0
        : 0;
    if (!force && percent === lastPercent) {
      return;
    }
    lastPercent = percent;
    onProgress({
      percent,
      loadedBytes,
      totalBytes: totalBytes ?? undefined,
    });
  };

  emitProgress(true);

  const reader = response.body.getReader();
  const output = await fs.promises.open(outputPath, "w");
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (!value || value.byteLength === 0) {
        continue;
      }

      loadedBytes += value.byteLength;
      await output.write(value);
      emitProgress();
    }

    if (totalBytes && loadedBytes < totalBytes) {
      loadedBytes = totalBytes;
    }
    emitProgress(true);
  } finally {
    reader.releaseLock();
    await output.close();
  }

  return true;
};

const downloadViaPublicDrive = async (
  fileId: string,
  outputPath: string,
  onProgress?: (progress: JobProgress) => void,
): Promise<boolean> => {
  const url = `https://drive.google.com/uc?export=download&id=${fileId}`;

  try {
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) {
      return false;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/html")) {
      const html = await response.text();
      const tokenMatch = html.match(/confirm=([0-9A-Za-z_\-]+)/);
      if (!tokenMatch) {
        return false;
      }

      const confirmUrl = `https://drive.google.com/uc?export=download&confirm=${tokenMatch[1]}&id=${fileId}`;
      const confirmResponse = await fetch(confirmUrl, { redirect: "follow" });
      if (!confirmResponse.ok) {
        return false;
      }
      return downloadFetchResponseToPath(confirmResponse, outputPath, onProgress);
    }

    return downloadFetchResponseToPath(response, outputPath, onProgress);
  } catch {
    return false;
  }
};

const cleanDriveId = (value: unknown): string => {
  const text = String(value ?? "").trim();
  const match = text.match(/(?:id=|\/d\/)([a-zA-Z0-9_-]{10,})/);
  return match?.[1] ?? text;
};

const parseTime = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text || text.toUpperCase() === "N/A") return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
};

const mapQaToSheetRows = (args: {
  qaItems: QaItem[];
  meta: {
    userId: string;
    fullName: string;
    mobile: string;
    jobId: string;
    companyName: string;
    interviewRound: string;
    interviewDate: string;
    clipStart: number;
    clipEnd: number;
    videoLink: string;
    transcriptLink: string;
    driveFileId: string;
    sourceType: string;
    product: string;
  };
}): Array<Record<string, string>> => {
  return args.qaItems.map((item) => ({
    user_id: args.meta.userId,
    full_name: args.meta.fullName,
    mobile_number: args.meta.mobile,
    job_id: args.meta.jobId,
    company_name: args.meta.companyName,
    question_text: String(item.question_text ?? ""),
    answer_text: String(item.answer_text ?? ""),
    relevancy_score: String(item.relevancy_score ?? "N/A"),
    question_type: forceEnumFormat(item.question_type ?? "N/A"),
    tech_stacks: forceEnumFormat(item.question_concept ?? "N/A"),
    topic: forceEnumFormat(item.topic ?? "N/A"),
    sub_topic: forceEnumFormat(item.sub_topic ?? "N/A"),
    difficulty: forceEnumFormat(item.difficulty ?? "N/A"),
    interview_round: forceEnumFormat(args.meta.interviewRound),
    clip_start_time: String(args.meta.clipStart),
    clip_end_time: String(args.meta.clipEnd),
    video_link: args.meta.videoLink,
    transcript_link: args.meta.transcriptLink,
    drive_file_id: args.meta.driveFileId,
    curriculum_coverage: forceEnumFormat(item.curriculum_coverage ?? "N/A"),
    question_uid: randomUUID(),
    interview_date: args.meta.interviewDate,
    question_creation_datetime: nowDateTime(),
    source_type: args.meta.sourceType,
    product: args.meta.product,
  }));
};

const ensureHeaderOrder = (rows: Array<Record<string, string>>): Array<Record<string, string>> => {
  return rows.map((row) => {
    const ordered: Record<string, string> = {};
    for (const header of SHEET_HEADERS) {
      ordered[header] = row[header] ?? "N/A";
    }
    return ordered;
  });
};

const runQnaPipeline = async (args: {
  runtime: ProviderRuntimeConfig;
  transcriptText: string;
  qnaPrompt: string;
  classifyPrompt: string;
  abortIfCancelled?: () => void;
}): Promise<QaItem[]> => {
  args.abortIfCancelled?.();
  const raw = await processLargeTranscriptWithOverlap(
    args.runtime,
    args.transcriptText,
    args.qnaPrompt,
    QNA_CHUNK_SIZE,
    QNA_CHUNK_OVERLAP,
    args.abortIfCancelled,
  );
  args.abortIfCancelled?.();

  const deduped = deduplicateQna(raw);
  return classifyQnaList(args.runtime, deduped, args.classifyPrompt, 12, args.abortIfCancelled);
};

const saveQaCsv = (filePath: string, rows: Array<Record<string, string>>): void => {
  if (rows.length === 0) return;

  const headers = Object.keys(rows[0]);
  const lines = [headers.join(",")];

  for (const row of rows) {
    lines.push(
      headers
        .map((header) => {
          const value = String(row[header] ?? "");
          if (value.includes(",") || value.includes("\n") || value.includes('"')) {
            return `"${value.replace(/"/g, '""')}"`;
          }
          return value;
        })
        .join(","),
    );
  }

  writeTextFile(filePath, lines.join("\n"));
};

const processInterviewRow = async (args: {
  runtime: ProviderRuntimeConfig;
  row: InterviewInputRow;
  runToken: string;
  qnaPrompt: string;
  classifyPrompt: string;
  product: string;
  rowIndex: number;
  totalRows: number;
  onStatus?: StatusUpdateCallback;
  abortIfCancelled?: () => void;
}): Promise<ProcessInterviewRowResult> => {
  args.abortIfCancelled?.();
  const userId = String(args.row.user_id ?? "N/A").trim();
  const fileId = cleanDriveId(args.row.drive_file_id);
  const fullName = String(args.row.fullName ?? "N/A").trim();
  const mobile = String(args.row.MobileNumber ?? "N/A").trim();
  const jobId = String(args.row.job_id ?? "N/A").trim();
  const company = String(args.row.company_name ?? "N/A").trim();
  const interviewRound = String(args.row.interview_round ?? "N/A").trim();
  const interviewDate = String(args.row.interview_date ?? "").trim();

  if (!interviewDate) {
    throw new Error("Missing interview_date for interview analyzer row.");
  }

  const rawStart = parseTime(args.row.clip_start_time);
  const rawEnd = parseTime(args.row.clip_end_time);

  const processFullVideo = rawEnd === null;
  let startTime = rawStart ?? 0;
  let endTime = rawEnd ?? 0;

  const videoPath = path.join(APP_DIRS.downloadedVideos, `${fileId}.mp4`);
  const videoUrl = `https://drive.google.com/file/d/${fileId}/view`;
  const candidatePrefix = `Candidate ${args.rowIndex}/${args.totalRows}`;
  args.onStatus?.(`${candidatePrefix}: validating cached video...`);

  let videoValidation = validateVideoFile(videoPath);
  if (!videoValidation.ok && fs.existsSync(videoPath)) {
    safeRemoveFile(videoPath);
  }

  if (!fs.existsSync(videoPath)) {
    args.abortIfCancelled?.();
    args.onStatus?.(`${candidatePrefix}: downloading video...`, { progress: { percent: 0 } });
    const publicDownloadOk = await downloadViaPublicDrive(fileId, videoPath, (progress) => {
      args.onStatus?.(`${candidatePrefix}: downloading video...`, { progress });
    });
    args.abortIfCancelled?.();
    videoValidation = validateVideoFile(videoPath);

    if (!publicDownloadOk || !videoValidation.ok) {
      if (fs.existsSync(videoPath)) safeRemoveFile(videoPath);
      const fallbackReason = !publicDownloadOk
        ? "public download request failed"
        : `downloaded file invalid (${videoValidation.reason})`;
      args.onStatus?.(
        `${candidatePrefix}: public download failed (${fallbackReason}), switching to Drive API...`,
        { progress: { percent: 0 } },
      );
      args.onStatus?.(`${candidatePrefix}: trying Drive API download...`, { progress: { percent: 0 } });
      const driveResult = await downloadDriveFileToPath(fileId, videoPath, (progress) => {
        args.onStatus?.(`${candidatePrefix}: trying Drive API download...`, { progress });
      });
      args.abortIfCancelled?.();
      if (driveResult !== "Success") {
        safeRemoveFile(videoPath);
        throw new Error(`Drive API Download failed (${driveResult}).`);
      }
      videoValidation = validateVideoFile(videoPath);
      if (!videoValidation.ok) {
        safeRemoveFile(videoPath);
        throw new Error(`Drive API file invalid (${videoValidation.reason}).`);
      }
    }
  }

  const finalValidation = validateVideoFile(videoPath);
  if (!finalValidation.ok) {
    safeRemoveFile(videoPath);
    throw new Error(`Failed to get a valid video file (${finalValidation.reason}).`);
  }

  if (processFullVideo || endTime === 0) {
    args.abortIfCancelled?.();
    args.onStatus?.(`${candidatePrefix}: determining clip duration...`);
    const duration = getMediaDuration(videoPath);
    if (!duration) {
      throw new Error("Could not determine video duration.");
    }
    endTime = duration;
  }

  const baseName =
    `${fileId}_${Math.floor(startTime)}_${Math.floor(endTime)}_` +
    `${args.runToken}_${args.rowIndex}`;
  const audioPath = path.join(APP_DIRS.downloadedVideos, `${baseName}.mp3`);
  const transcriptPath = path.join(APP_DIRS.generatedTranscripts, `${baseName}.txt`);
  const qnaCsvPath = path.join(APP_DIRS.qa, `${baseName}_consolidated.csv`);

  if (!fs.existsSync(audioPath)) {
    args.abortIfCancelled?.();
    args.onStatus?.(`${candidatePrefix}: extracting audio...`);
    extractAudioSegment(videoPath, audioPath, startTime, endTime);
  }

  if (!fs.existsSync(transcriptPath)) {
    args.abortIfCancelled?.();
    args.onStatus?.(`${candidatePrefix}: generating transcript...`);
    await generateTranscript(args.runtime, audioPath, transcriptPath, args.onStatus, args.abortIfCancelled);
  }
  args.abortIfCancelled?.();

  const transcriptText = readTextFileIfExists(transcriptPath);
  let transcriptLink = "N/A";
  if (transcriptText.trim()) {
    args.abortIfCancelled?.();
    args.onStatus?.(`${candidatePrefix}: creating transcript gist...`);
    transcriptLink = await createPublicGist(`transcript_${baseName}.txt`, transcriptText);
    args.abortIfCancelled?.();
  }

  args.abortIfCancelled?.();
  args.onStatus?.(`${candidatePrefix}: extracting Q&A...`);
  const qaItems = await runQnaPipeline({
    runtime: args.runtime,
    transcriptText,
    qnaPrompt: args.qnaPrompt,
    classifyPrompt: args.classifyPrompt,
    abortIfCancelled: args.abortIfCancelled,
  });
  args.abortIfCancelled?.();

  const rows = mapQaToSheetRows({
    qaItems,
    meta: {
      userId,
      fullName,
      mobile,
      jobId,
      companyName: company,
      interviewRound,
      interviewDate,
      clipStart: startTime,
      clipEnd: endTime,
      videoLink: videoUrl,
      transcriptLink,
      driveFileId: fileId,
      sourceType: "Interview analyser",
      product: args.product,
    },
  });

  args.abortIfCancelled?.();
  saveQaCsv(qnaCsvPath, rows);
  return {
    rows,
    cleanupPaths: [audioPath, transcriptPath, qnaCsvPath],
  };
};

export const runInterviewAnalyzer = async (args: {
  rows: InterviewInputRow[];
  product: string;
  provider: AiProvider;
  onStatus?: StatusUpdateCallback;
  abortIfCancelled?: () => void;
}): Promise<InterviewAnalysisResult> => {
  args.abortIfCancelled?.();
  args.onStatus?.("Preparing interview analyzer...");
  ensureDirs(Object.values(APP_DIRS));
  const runtime = await getRuntimeProviderConfig(args.provider);
  const storageSettings = await getStorageSettings();

  if (!checkFfmpegInstalled()) {
    throw new Error("FFmpeg is not installed.");
  }

  args.onStatus?.("Loading curriculum and prompts...");
  const curriculum = await getCurriculumSnippet(15000);
  args.abortIfCancelled?.();
  const qnaPrompt = loadQnaPrompt();
  const classifyTemplate = loadClassifyPromptTemplate();
  const classifyPrompt = classifyTemplate.replace("{{CURRICULUM_CONTEXT}}", curriculum);

  const finalRows: Array<Record<string, string>> = [];
  const cleanupPaths: string[] = [];
  const totalRows = args.rows.length;
  const runToken = randomUUID().replace(/-/g, "").slice(0, 12);
  let rowIndex = 0;

  for (const row of args.rows) {
    args.abortIfCancelled?.();
    rowIndex += 1;
    const processed = await processInterviewRow({
      runtime,
      row,
      runToken,
      qnaPrompt,
      classifyPrompt,
      product: args.product,
      rowIndex,
      totalRows,
      onStatus: args.onStatus,
      abortIfCancelled: args.abortIfCancelled,
    });
    finalRows.push(...processed.rows);
    cleanupPaths.push(...processed.cleanupPaths);
    args.onStatus?.(`Candidate ${rowIndex}/${totalRows}: completed.`, {
      partialResult: {
        rows: ensureHeaderOrder(finalRows),
        savedToSheet: false,
        savedToBigQuery: false,
      },
    });
  }

  args.abortIfCancelled?.();
  const orderedRows = ensureHeaderOrder(finalRows);
  let savedToSheet = false;
  if (storageSettings.saveToSheets) {
    args.onStatus?.("Saving interview rows to sheet...");
    savedToSheet = await appendRowsWithHeaders({
      sheetName: SHEET_NAMES.interview,
      headers: SHEET_HEADERS,
      rows: orderedRows,
    });
  } else {
    args.onStatus?.("Sheet save is disabled in settings. Skipping sheet save.");
  }

  let savedToBigQuery = false;
  if (storageSettings.saveToBigQuery) {
    args.onStatus?.("Saving interview rows to BigQuery...");
    savedToBigQuery = await appendRowsToBigQuery({
      tableName: BIGQUERY_TABLE_NAMES.interview,
      rows: orderedRows,
    });
  } else {
    args.onStatus?.("BigQuery save is disabled in settings. Skipping BigQuery save.");
  }

  const allRequestedSavesSucceeded =
    (!storageSettings.saveToSheets || savedToSheet) &&
    (!storageSettings.saveToBigQuery || savedToBigQuery);

  if (allRequestedSavesSucceeded) {
    args.onStatus?.("Cleaning up local interview artifacts...");
    cleanupFiles(cleanupPaths);
  }

  return { rows: orderedRows, savedToSheet, savedToBigQuery };
};

export const runVideoUploader = async (args: {
  metadata: VideoUploaderMetadata;
  uploadedFile: Express.Multer.File;
  product: string;
  provider: AiProvider;
  onStatus?: StatusUpdateCallback;
  abortIfCancelled?: () => void;
}): Promise<InterviewAnalysisResult> => {
  args.abortIfCancelled?.();
  args.onStatus?.("Preparing local video uploader...");
  ensureDirs(Object.values(APP_DIRS));
  const runtime = await getRuntimeProviderConfig(args.provider);
  const storageSettings = await getStorageSettings();

  const interviewDate = String(args.metadata.interview_date ?? "").trim();
  if (!interviewDate) {
    throw new Error("Missing interview_date in video uploader metadata.");
  }

  if (!checkFfmpegInstalled()) {
    throw new Error("FFmpeg is not installed.");
  }

  args.onStatus?.("Loading curriculum and prompts...");
  const curriculum = await getCurriculumSnippet(15000);
  args.abortIfCancelled?.();
  const qnaPrompt = loadQnaPrompt();
  const classifyTemplate = loadClassifyPromptTemplate();
  const classifyPrompt = classifyTemplate.replace("{{CURRICULUM_CONTEXT}}", curriculum);

  const timestamp = Date.now();
  const uploadToken = randomUUID().replace(/-/g, "").slice(0, 8);
  args.abortIfCancelled?.();
  args.onStatus?.("Saving uploaded video...");
  const uploadExt = path.extname(args.uploadedFile.originalname) || ".mp4";
  const sourceVideoPath = path.join(APP_DIRS.downloadedVideos, `uploaded_${timestamp}_${uploadToken}${uploadExt}`);
  fs.writeFileSync(sourceVideoPath, args.uploadedFile.buffer);

  const baseName = `${args.metadata.user_id || "candidate"}_${timestamp}_${uploadToken}`;
  const audioPath = path.join(APP_DIRS.downloadedVideos, `${baseName}.mp3`);
  const transcriptPath = path.join(APP_DIRS.generatedTranscripts, `${baseName}.txt`);

  if (!fs.existsSync(audioPath)) {
    args.abortIfCancelled?.();
    args.onStatus?.("Extracting audio...");
    extractAudioFile(sourceVideoPath, audioPath);
  }

  if (!fs.existsSync(transcriptPath)) {
    args.abortIfCancelled?.();
    args.onStatus?.("Generating transcript...");
    await generateTranscript(runtime, audioPath, transcriptPath, args.onStatus, args.abortIfCancelled);
  }
  args.abortIfCancelled?.();

  const transcriptText = readTextFileIfExists(transcriptPath);
  args.onStatus?.("Creating transcript gist...");
  const transcriptLink = transcriptText
    ? await createPublicGist(`trans_${baseName}.txt`, transcriptText)
    : "N/A";
  args.abortIfCancelled?.();

  args.onStatus?.("Extracting and classifying Q&A...");
  const qaItems = await runQnaPipeline({
    runtime,
    transcriptText,
    qnaPrompt,
    classifyPrompt,
    abortIfCancelled: args.abortIfCancelled,
  });
  args.abortIfCancelled?.();

  const clipEnd = getMediaDuration(sourceVideoPath) ?? 0;

  const rows = mapQaToSheetRows({
    qaItems,
    meta: {
      userId: String(args.metadata.user_id ?? "N/A"),
      fullName: String(args.metadata.fullName ?? "N/A"),
      mobile: String(args.metadata.MobileNumber ?? "N/A"),
      jobId: String(args.metadata.job_id ?? "N/A"),
      companyName: String(args.metadata.company_name ?? "N/A"),
      interviewRound: String(args.metadata.interview_round ?? "N/A"),
      interviewDate,
      clipStart: 0,
      clipEnd,
      videoLink: "Local Upload",
      transcriptLink,
      driveFileId: "Local",
      sourceType: "Video uploader",
      product: args.product,
    },
  });

  const orderedRows = ensureHeaderOrder(rows);
  args.abortIfCancelled?.();
  let savedToSheet = false;
  if (storageSettings.saveToSheets) {
    args.onStatus?.("Saving video uploader rows to sheet...");
    savedToSheet = await appendRowsWithHeaders({
      sheetName: SHEET_NAMES.interview,
      headers: SHEET_HEADERS,
      rows: orderedRows,
    });
  } else {
    args.onStatus?.("Sheet save is disabled in settings. Skipping sheet save.");
  }

  let savedToBigQuery = false;
  if (storageSettings.saveToBigQuery) {
    args.onStatus?.("Saving video uploader rows to BigQuery...");
    savedToBigQuery = await appendRowsToBigQuery({
      tableName: BIGQUERY_TABLE_NAMES.interview,
      rows: orderedRows,
    });
  } else {
    args.onStatus?.("BigQuery save is disabled in settings. Skipping BigQuery save.");
  }

  const allRequestedSavesSucceeded =
    (!storageSettings.saveToSheets || savedToSheet) &&
    (!storageSettings.saveToBigQuery || savedToBigQuery);

  if (allRequestedSavesSucceeded) {
    args.onStatus?.("Cleaning up local video uploader artifacts...");
    cleanupFiles([sourceVideoPath, audioPath, transcriptPath]);
  }

  return { rows: orderedRows, savedToSheet, savedToBigQuery };
};
