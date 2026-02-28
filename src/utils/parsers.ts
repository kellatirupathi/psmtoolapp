import Papa from "papaparse";
import type { AssignmentInputRow, InterviewInputRow, VideoUploaderMetadata } from "../types";

const normalizeCell = (value: unknown): string => String(value ?? "").trim();

export const parseCsvRows = (fileText: string): Array<Record<string, string>> => {
  const parsed = Papa.parse<Record<string, string>>(fileText, {
    header: true,
    skipEmptyLines: true,
  });

  return parsed.data.map((row) => {
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(row)) {
      normalized[String(key).trim()] = normalizeCell(value);
    }
    return normalized;
  });
};

export const parseTsvLines = (text: string): string[][] => {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split("\t").map((entry) => entry.trim()));
};

const INTERVIEW_COLUMNS = [
  "user_id",
  "fullName",
  "MobileNumber",
  "interview_round",
  "drive_file_id",
  "job_id",
  "company_name",
  "interview_date",
  "clip_start_time",
  "clip_end_time",
] as const;

const normalizeInterviewDateFromRow = (row: Record<string, string>): string =>
  normalizeCell(row.interview_date || row["Interview Date"] || row.interviewDate);

export const parseInterviewRowsFromPaste = (text: string): InterviewInputRow[] => {
  const lines = parseTsvLines(text);
  const rows: InterviewInputRow[] = [];

  for (const cells of lines) {
    if (![8, 9, 10].includes(cells.length)) {
      continue;
    }

    const mapped: Record<string, string | number | null> = {};
    for (let i = 0; i < cells.length; i += 1) {
      mapped[INTERVIEW_COLUMNS[i]] = cells[i];
    }

    if (cells.length === 8) {
      mapped.clip_start_time = 0;
      mapped.clip_end_time = null;
    }

    if (cells.length === 9) {
      mapped.clip_end_time = null;
    }

    rows.push(mapped as InterviewInputRow);
  }

  return rows;
};

export const normalizeInterviewCsvRows = (rows: Array<Record<string, string>>): InterviewInputRow[] => {
  return rows
    .filter(
      (row) =>
        normalizeCell(row.drive_file_id || row["drive_file_id"]).length > 0 &&
        normalizeInterviewDateFromRow(row).length > 0,
    )
    .map((row) => ({
      user_id: normalizeCell(row.user_id),
      fullName: normalizeCell(row.fullName || row.full_name),
      MobileNumber: normalizeCell(row.MobileNumber || row.mobile_number),
      interview_round: normalizeCell(row.interview_round),
      drive_file_id: normalizeCell(row.drive_file_id),
      job_id: normalizeCell(row.job_id),
      company_name: normalizeCell(row.company_name),
      interview_date: normalizeInterviewDateFromRow(row),
      clip_start_time: normalizeCell(row.clip_start_time) || null,
      clip_end_time: normalizeCell(row.clip_end_time) || null,
    }));
};

export const parseVideoMetadataFromPaste = (text: string): VideoUploaderMetadata | null => {
  const rows = parseInterviewRowsFromPaste(text);
  if (rows.length === 0) return null;

  const first = rows[0];
  return {
    user_id: first.user_id,
    fullName: first.fullName,
    MobileNumber: first.MobileNumber,
    interview_round: first.interview_round,
    drive_file_id: first.drive_file_id,
    job_id: first.job_id,
    company_name: first.company_name,
    interview_date: first.interview_date,
    clip_start_time: first.clip_start_time,
    clip_end_time: first.clip_end_time,
  };
};

export const parseVideoMetadataFromCsvRows = (
  rows: Array<Record<string, string>>,
): VideoUploaderMetadata | null => {
  if (rows.length === 0) return null;

  const row = rows[0];
  return {
    user_id: normalizeCell(row.user_id),
    fullName: normalizeCell(row.fullName || row.full_name),
    MobileNumber: normalizeCell(row.MobileNumber || row.mobile_number),
    interview_round: normalizeCell(row.interview_round),
    drive_file_id: normalizeCell(row.drive_file_id || row["drive_file_id"]) || undefined,
    job_id: normalizeCell(row.job_id),
    company_name: normalizeCell(row.company_name),
    interview_date: normalizeInterviewDateFromRow(row),
    clip_start_time: normalizeCell(row.clip_start_time) || 0,
    clip_end_time: normalizeCell(row.clip_end_time) || null,
  };
};

export const parseAssignmentsFromPaste = (text: string): AssignmentInputRow[] => {
  const lines = parseTsvLines(text);
  const rows: AssignmentInputRow[] = [];

  for (const cells of lines) {
    if (cells.length < 4) continue;
    rows.push({
      job_id: cells[0],
      company_name: cells[1],
      assignment_link: cells[2],
      assignment_date: cells[3],
    });
  }

  return rows;
};

export const normalizeAssignmentsCsvRows = (rows: Array<Record<string, string>>): AssignmentInputRow[] => {
  return rows
    .filter((row) => normalizeCell(row.assignment_link).length > 0)
    .map((row) => ({
      job_id: normalizeCell(row.job_id),
      company_name: normalizeCell(row.company_name),
      assignment_link: normalizeCell(row.assignment_link),
      assignment_date: normalizeCell(row.assignment_date),
    }));
};
