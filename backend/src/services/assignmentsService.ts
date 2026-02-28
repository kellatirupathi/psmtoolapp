import { randomUUID } from "node:crypto";
import { getCurriculumSnippet } from "../utils/curriculum";
import { forceEnumFormat } from "../utils/enum";
import { appendRowsToBigQuery } from "../utils/bigquery";
import { appendRowsWithHeaders } from "../utils/google";
import { aiChatJson } from "../utils/aiProvider";
import { smartFetchContent } from "../utils/contentExtraction";
import { BIGQUERY_TABLE_NAMES, SHEET_NAMES } from "../config";
import type { AiProvider, AssignmentInputRow } from "../types";
import { getRuntimeProviderConfig, getStorageSettings, type ProviderRuntimeConfig } from "./settingsService";

const SHEET_HEADERS = [
  "job_id",
  "company_name",
  "question_text",
  "question_type",
  "tech_stacks",
  "difficulty_level",
  "curriculum_coverage",
  "question_uid",
  "assignment_date",
  "question_creation_datetime",
  "assignment_link",
  "product",
];

const nowDate = (): string => new Date().toISOString().slice(0, 10);
const nowDateTime = (): string => new Date().toISOString().slice(0, 19).replace("T", " ");

const buildSystemPrompt = async (): Promise<string> => {
  const curriculum = await getCurriculumSnippet(10000);

  return `
You are an expert Senior Technical Curriculum Architect. 
Your task is to analyze assignment descriptions and extract structured metadata.

CURRICULUM CONTEXT:
${curriculum}

OUTPUT FORMAT: JSON Object ONLY.

FIELDS TO EXTRACT:
1. "question_text": 
   - A professional executive summary (2-4 sentences) of WHAT needs to be built.

2. "tech_stacks": 
   - LIST the required technologies.
   - Map to: [JAVA, PYTHON, JAVASCRIPT, HTML, CSS, SQL, REACT_JS, NODE_JS, EXPRESS_JS, SPRING_BOOT, DSA, SYSTEM_DESIGN, WEB_DEVELOPMENT, CLOUD_COMPUTING, DATA_SCIENCE].
   - Fallback: GENERAL.

3. "difficulty_level": 
   - EASY | MEDIUM | HARD based on complexity.

4. "question_type":
   - CODING | PROJECT | ASSIGNMENT | CASE_STUDY.
   - Default: ASSIGNMENT.

5. "curriculum_coverage":
   - COVERED | NOT_COVERED | N/A.
   - Check against CURRICULUM CONTEXT.
`;
};

const runAssignmentAnalysis = async (
  runtime: ProviderRuntimeConfig,
  systemPrompt: string,
  content: string,
): Promise<Record<string, unknown> | null> => {
  if (!content || content.length < 50 || content.startsWith("Error")) {
    return null;
  }

  const cleanContent = content.slice(0, 20000);

  const userPrompt = `Analyze this assignment text:\n---\n${cleanContent}\n---`;

  try {
    const parsed = await aiChatJson(
      runtime,
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      { responseAsJsonObject: true, temperature: 0.1, timeoutMs: 60000 },
    );

    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, unknown>;
    }

    return null;
  } catch {
    return null;
  }
};

export const analyzeAssignments = async (
  rows: AssignmentInputRow[],
  product: string,
  provider: AiProvider,
  onStatus?: (message: string) => void,
  abortIfCancelled?: () => void,
): Promise<{ rows: Array<Record<string, string>>; savedToSheet: boolean; savedToBigQuery: boolean }> => {
  abortIfCancelled?.();
  const runtime = await getRuntimeProviderConfig(provider);
  const storageSettings = await getStorageSettings();
  onStatus?.("Loading curriculum context...");
  const systemPrompt = await buildSystemPrompt();
  abortIfCancelled?.();
  const finalRows: Array<Record<string, string>> = [];
  const totalRows = rows.length;
  let currentRow = 0;

  for (const row of rows) {
    abortIfCancelled?.();
    currentRow += 1;
    const link = String(row.assignment_link ?? "").trim();
    if (!link) continue;

    const jobId = String(row.job_id ?? "").trim();
    const company = String(row.company_name ?? "Unknown").trim();
    const assignmentDate = String(row.assignment_date ?? nowDate()).trim() || nowDate();

    onStatus?.(`Fetching assignment content ${currentRow}/${totalRows}...`);
    const extractedText = await smartFetchContent(link, runtime);
    abortIfCancelled?.();
    onStatus?.(`Analyzing assignment ${currentRow}/${totalRows}...`);
    const analysis = await runAssignmentAnalysis(runtime, systemPrompt, extractedText);
    abortIfCancelled?.();

    let questionText = "FAILED: Content empty or unrecognizable";
    let questionType = "ASSIGNMENT";
    let techStacks: unknown = "GENERAL";
    let difficultyLevel: unknown = "MEDIUM";
    let curriculumCoverage: unknown = "N/A";

    if (analysis) {
      questionText = String(analysis.question_text ?? questionText);
      questionType = String(analysis.question_type ?? questionType);
      techStacks = analysis.tech_stacks ?? techStacks;
      difficultyLevel = analysis.difficulty_level ?? difficultyLevel;
      curriculumCoverage = analysis.curriculum_coverage ?? curriculumCoverage;
    } else if (extractedText.startsWith("Error")) {
      questionText = `FAILED: ${extractedText}`;
    }

    finalRows.push({
      job_id: jobId,
      company_name: company,
      question_text: questionText,
      question_type: forceEnumFormat(questionType),
      tech_stacks: forceEnumFormat(techStacks),
      difficulty_level: forceEnumFormat(difficultyLevel),
      curriculum_coverage: forceEnumFormat(curriculumCoverage),
      question_uid: randomUUID(),
      assignment_date: assignmentDate,
      question_creation_datetime: nowDateTime(),
      assignment_link: link,
      product,
    });
  }

  const orderedRows = finalRows.map((row) => {
    const normalized: Record<string, string> = {};
    for (const header of SHEET_HEADERS) {
      normalized[header] = row[header] ?? "N/A";
    }
    return normalized;
  });

  abortIfCancelled?.();
  let savedToSheet = false;
  if (storageSettings.saveToSheets) {
    onStatus?.("Saving assignment results to sheet...");
    savedToSheet = await appendRowsWithHeaders({
      sheetName: SHEET_NAMES.assignments,
      headers: SHEET_HEADERS,
      rows: orderedRows,
    });
  } else {
    onStatus?.("Sheet save is disabled in settings. Skipping sheet save.");
  }

  let savedToBigQuery = false;
  if (storageSettings.saveToBigQuery) {
    onStatus?.("Saving assignment results to BigQuery...");
    savedToBigQuery = await appendRowsToBigQuery({
      tableName: BIGQUERY_TABLE_NAMES.assignments,
      rows: orderedRows,
    });
  } else {
    onStatus?.("BigQuery save is disabled in settings. Skipping BigQuery save.");
  }

  return { rows: orderedRows, savedToSheet, savedToBigQuery };
};
