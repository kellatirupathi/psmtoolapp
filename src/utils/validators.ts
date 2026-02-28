import type { InterviewInputRow, VideoUploaderMetadata } from "../types";

export type ValidationSeverity = "error" | "warning";

export type ValidationIssue = {
  row: number;
  column: string;
  severity: ValidationSeverity;
  message: string;
  value?: string;
};

export type ValidationSummary = {
  total: number;
  valid: number;
  invalid: number;
  errors: number;
  warnings: number;
};

export type ValidationReport<T> = {
  validRows: T[];
  invalidRows: T[];
  issues: ValidationIssue[];
  summary: ValidationSummary;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const GOOGLE_DRIVE_ID_RE = /^[A-Za-z0-9_-]{10,}$/;
const GOOGLE_DRIVE_URL_ID_RE = /(?:id=|\/d\/)([A-Za-z0-9_-]{10,})/;

const isBlank = (value: unknown): boolean => String(value ?? "").trim().length === 0;

const isValidDateString = (value: string): boolean => {
  if (!DATE_RE.test(value)) return false;
  const [year, month, day] = value.split("-").map((item) => Number(item));
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
};

const isValidDriveIdentifier = (value: string): boolean => {
  const normalized = value.trim();
  if (!normalized) return false;
  if (GOOGLE_DRIVE_ID_RE.test(normalized)) return true;
  return GOOGLE_DRIVE_URL_ID_RE.test(normalized);
};

const parseNumeric = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
};

const getMobileDigits = (value: string): string => value.replace(/\D/g, "");

const buildReport = <T>(rows: T[], issues: ValidationIssue[]): ValidationReport<T> => {
  const invalidRowIndexes = new Set(
    issues.filter((issue) => issue.severity === "error").map((issue) => issue.row),
  );

  const validRows: T[] = [];
  const invalidRows: T[] = [];

  rows.forEach((row, index) => {
    if (invalidRowIndexes.has(index + 1)) {
      invalidRows.push(row);
    } else {
      validRows.push(row);
    }
  });

  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.filter((issue) => issue.severity === "warning").length;

  return {
    validRows,
    invalidRows,
    issues,
    summary: {
      total: rows.length,
      valid: validRows.length,
      invalid: invalidRows.length,
      errors,
      warnings,
    },
  };
};

export const validateInterviewRows = (rows: InterviewInputRow[]): ValidationReport<InterviewInputRow> => {
  const issues: ValidationIssue[] = [];

  rows.forEach((row, index) => {
    const rowNumber = index + 1;

    const requiredStringColumns: Array<keyof InterviewInputRow> = [
      "user_id",
      "fullName",
      "MobileNumber",
      "interview_round",
      "drive_file_id",
      "job_id",
      "company_name",
      "interview_date",
    ];

    for (const column of requiredStringColumns) {
      const raw = String(row[column] ?? "");
      if (isBlank(raw)) {
        issues.push({
          row: rowNumber,
          column,
          severity: "error",
          message: "Required field is missing.",
          value: raw,
        });
      }
    }

    const interviewDate = String(row.interview_date ?? "").trim();
    if (interviewDate && !isValidDateString(interviewDate)) {
      issues.push({
        row: rowNumber,
        column: "interview_date",
        severity: "error",
        message: "Expected YYYY-MM-DD date.",
        value: interviewDate,
      });
    }

    const driveFileId = String(row.drive_file_id ?? "").trim();
    if (driveFileId && !isValidDriveIdentifier(driveFileId)) {
      issues.push({
        row: rowNumber,
        column: "drive_file_id",
        severity: "error",
        message: "Invalid Google Drive file id/url format.",
        value: driveFileId,
      });
    }

    const startRaw = row.clip_start_time;
    const endRaw = row.clip_end_time;
    const clipStart = parseNumeric(startRaw);
    const clipEnd = parseNumeric(endRaw);

    if (!isBlank(startRaw) && clipStart === null) {
      issues.push({
        row: rowNumber,
        column: "clip_start_time",
        severity: "error",
        message: "Clip start must be a number.",
        value: String(startRaw ?? ""),
      });
    }

    if (!isBlank(endRaw) && clipEnd === null) {
      issues.push({
        row: rowNumber,
        column: "clip_end_time",
        severity: "error",
        message: "Clip end must be a number.",
        value: String(endRaw ?? ""),
      });
    }

    if (clipStart !== null && clipEnd !== null && clipEnd <= clipStart) {
      issues.push({
        row: rowNumber,
        column: "clip_end_time",
        severity: "error",
        message: "Clip end must be greater than clip start.",
        value: String(endRaw ?? ""),
      });
    }

    if (clipStart !== null && clipStart < 0) {
      issues.push({
        row: rowNumber,
        column: "clip_start_time",
        severity: "error",
        message: "Clip start cannot be negative.",
        value: String(startRaw ?? ""),
      });
    }

    if (clipEnd !== null && clipEnd < 0) {
      issues.push({
        row: rowNumber,
        column: "clip_end_time",
        severity: "error",
        message: "Clip end cannot be negative.",
        value: String(endRaw ?? ""),
      });
    }

    const mobileRaw = String(row.MobileNumber ?? "").trim();
    const mobileDigits = getMobileDigits(mobileRaw);
    if (mobileRaw && (mobileDigits.length < 10 || mobileDigits.length > 15)) {
      issues.push({
        row: rowNumber,
        column: "MobileNumber",
        severity: "warning",
        message: "Mobile number looks unusual (expected 10-15 digits).",
        value: mobileRaw,
      });
    }
  });

  return buildReport(rows, issues);
};

export const validateVideoUploaderMetadata = (
  metadata: VideoUploaderMetadata | null,
): ValidationReport<VideoUploaderMetadata> => {
  if (!metadata) {
    return buildReport([], []);
  }

  const asInterviewRow: InterviewInputRow = {
    user_id: metadata.user_id,
    fullName: metadata.fullName,
    MobileNumber: metadata.MobileNumber,
    interview_round: metadata.interview_round,
    drive_file_id: metadata.drive_file_id ?? "Local",
    job_id: metadata.job_id,
    company_name: metadata.company_name,
    interview_date: metadata.interview_date,
    clip_start_time: metadata.clip_start_time ?? 0,
    clip_end_time: metadata.clip_end_time ?? null,
  };

  const rowReport = validateInterviewRows([asInterviewRow]);

  // drive_file_id is optional for local uploader; drop that specific error if field is empty.
  const filteredIssues = rowReport.issues.filter((issue) => {
    if (issue.column !== "drive_file_id") return true;
    const originalDrive = String(metadata.drive_file_id ?? "").trim();
    return originalDrive.length > 0;
  });

  return buildReport([metadata], filteredIssues);
};

