import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const FFMPEG_BIN = process.env.FFMPEG_PATH?.trim() || "ffmpeg";
const FFPROBE_BIN = process.env.FFPROBE_PATH?.trim() || "ffprobe";

export const checkFfmpegInstalled = (): boolean => {
  const ffmpeg = spawnSync(FFMPEG_BIN, ["-version"], { stdio: "ignore" });
  const ffprobe = spawnSync(FFPROBE_BIN, ["-version"], { stdio: "ignore" });
  return ffmpeg.status === 0 && ffprobe.status === 0;
};

export const getMediaDuration = (mediaPath: string): number | null => {
  const result = spawnSync(
    FFPROBE_BIN,
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      mediaPath,
    ],
    { encoding: "utf8" },
  );

  if (result.status !== 0) {
    return null;
  }

  const value = Number(result.stdout.trim());
  return Number.isFinite(value) ? value : null;
};

export const validateVideoFile = (
  videoPath: string,
  minSizeBytes = 100 * 1024,
): { ok: boolean; reason: string } => {
  if (!fs.existsSync(videoPath)) {
    return { ok: false, reason: "File not found" };
  }

  const stats = fs.statSync(videoPath);
  if (stats.size < minSizeBytes) {
    return { ok: false, reason: `File too small (${(stats.size / 1024).toFixed(2)} KB)` };
  }

  const duration = getMediaDuration(videoPath);
  if (!duration || duration <= 0) {
    return { ok: false, reason: "Unreadable video (ffprobe failed)" };
  }

  return { ok: true, reason: "" };
};

const runFfmpegCommand = (args: string[]): { ok: boolean; errorText: string } => {
  const result = spawnSync(FFMPEG_BIN, args, { encoding: "utf8" });
  if (result.status === 0) {
    return { ok: true, errorText: "" };
  }

  return {
    ok: false,
    errorText: (result.stderr || result.stdout || `ffmpeg exit code ${result.status}`).trim(),
  };
};

export const extractAudioSegment = (
  videoPath: string,
  audioPath: string,
  startTime: number,
  endTime: number,
): void => {
  const normalizedStart = Number(startTime);
  const normalizedEnd = Number(endTime);

  if (!Number.isFinite(normalizedStart) || !Number.isFinite(normalizedEnd) || normalizedEnd <= normalizedStart) {
    throw new Error(`Invalid segment window: start=${startTime} end=${endTime}`);
  }

  const duration = normalizedEnd - normalizedStart;

  const commands = [
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-ss",
      String(normalizedStart),
      "-i",
      videoPath,
      "-t",
      String(duration),
      "-vn",
      "-acodec",
      "libmp3lame",
      "-q:a",
      "2",
      audioPath,
    ],
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      videoPath,
      "-ss",
      String(normalizedStart),
      "-to",
      String(normalizedEnd),
      "-vn",
      "-acodec",
      "libmp3lame",
      "-q:a",
      "2",
      audioPath,
    ],
  ];

  let lastError = "Unknown ffmpeg error";
  for (const command of commands) {
    const result = runFfmpegCommand(command);
    if (result.ok && fs.existsSync(audioPath) && fs.statSync(audioPath).size > 0) {
      return;
    }

    lastError = result.errorText;
  }

  throw new Error(`FFmpeg extraction failed: ${lastError}`);
};

export const extractAudioFile = (videoPath: string, audioPath: string): void => {
  const command = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    videoPath,
    "-vn",
    "-acodec",
    "libmp3lame",
    "-q:a",
    "2",
    audioPath,
  ];

  const result = runFfmpegCommand(command);
  if (!result.ok) {
    throw new Error(`FFmpeg full audio extraction failed: ${result.errorText}`);
  }
};

export const splitAudioIntoChunks = (
  audioPath: string,
  chunkDurationSeconds = 600,
): string[] => {
  const duration = getMediaDuration(audioPath);
  if (!duration || duration <= chunkDurationSeconds) {
    return [audioPath];
  }

  const audioDir = path.dirname(audioPath);
  const base = path.parse(audioPath).name;
  const chunks: string[] = [];

  let start = 0;
  let index = 0;

  while (start < duration) {
    const chunkPath = path.join(audioDir, `${base}_part_${index}.mp3`);
    const result = runFfmpegCommand([
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      audioPath,
      "-ss",
      String(start),
      "-t",
      String(chunkDurationSeconds),
      "-c",
      "copy",
      chunkPath,
    ]);

    if (!result.ok) {
      throw new Error(`Chunking failed at index ${index}: ${result.errorText}`);
    }

    if (fs.existsSync(chunkPath) && fs.statSync(chunkPath).size > 0) {
      chunks.push(chunkPath);
    }

    start += chunkDurationSeconds;
    index += 1;
  }

  return chunks.length > 0 ? chunks : [audioPath];
};

export const formatTimestampClean = (secondsInput: number): string => {
  const seconds = Math.max(0, Math.floor(secondsInput));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${secs
    .toString()
    .padStart(2, "0")}`;
};

export const mistralSegmentsToCleanText = (
  segments: Array<{ start: number; text: string }>,
  offsetSeconds = 0,
): string => {
  return segments
    .map((segment) => {
      const timestamp = formatTimestampClean(segment.start + offsetSeconds);
      const text = segment.text.trim();
      return `[${timestamp}]  ${text}`;
    })
    .join("\n");
};

export const cleanTranscriptHallucinations = (transcript: string): string => {
  const lines = transcript.split("\n");
  const cleaned: string[] = [];

  let lastNorm = "";
  let repeatCount = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const match = line.match(/(\[.*?\]|\d{2}:\d{2}:\d{2}.*?)\s*(.*)/);
    if (!match) {
      cleaned.push(line);
      continue;
    }

    const textRaw = (match[2] ?? "").trim();
    const textNorm = textRaw.toLowerCase().replace(/[^\w]/g, "");
    if (!textNorm) continue;

    if (textNorm === lastNorm) {
      repeatCount += 1;
    } else {
      repeatCount = 0;
      lastNorm = textNorm;
    }

    if (repeatCount < 2) {
      cleaned.push(line);
    }
  }

  return cleaned.join("\n");
};
