import { randomUUID } from "node:crypto";
import { getCurriculumSnippet } from "../utils/curriculum";
import { forceEnumFormat } from "../utils/enum";
import { appendRowsToBigQuery } from "../utils/bigquery";
import { appendRowsWithHeaders } from "../utils/google";
import { aiJsonAsArray } from "../utils/aiProvider";
import type { JobUpdatePayload } from "../utils/jobManager";
import { BIGQUERY_TABLE_NAMES, SHEET_NAMES } from "../config";
import { getRuntimeProviderConfig, getStorageSettings, type ProviderRuntimeConfig } from "./settingsService";
import type { AiProvider } from "../types";

const DRILLDOWN_PROMPT_TEMPLATE = `
### SYSTEM ROLE
You are a technical interview question formatter and classifier.
You will receive raw interview notes for one interview round.
Your task is to convert unformatted notes into well-formed interview questions, classify each question, and mark curriculum coverage.

### INPUT DATA
You will receive one JSON object:
- \`interview_round\` (round name)
- \`round_text\` (raw notes for that round, may be shorthand)

### CURRICULUM CONTEXT
Use this curriculum text to determine coverage:
{{CURRICULUM_CONTEXT}}

### OUTPUT STRUCTURE
Return a JSON array.
Each item must include:
- \`question_text\`
- \`question_type\`
- \`question_concept\`
- \`difficulty\`
- \`topic\`
- \`sub_topic\`
- \`curriculum_coverage\` (COVERED | NOT_COVERED | N/A)

### ENUM RULES (UPPERCASE_SNAKE_CASE)
* **question_type:**
  * \`CODING\`
  * \`THEORY\`
  * \`BEHAVIORAL\`
  * \`SELF_INTRODUCTION\`
  * \`PROJECT\`
  * \`GENERAL\`

* **difficulty:**
  * \`EASY\`
  * \`MEDIUM\`
  * \`HARD\`

* **question_concept:**
  * Use one best-fit value from this list:
    * JAVA, PYTHON, JAVASCRIPT, C++, C_SHARP, RUST, TYPESCRIPT, HTML, CSS, SQL
    * REACT_JS, NODE_JS, EXPRESS_JS, NEXT_JS, ANGULAR_JS, SPRING_BOOT, BOOTSTRAP, DJANGO, FLASK
    * DSA, OOP, SYSTEM_DESIGN, DBMS, OS, CN
    * AI_ML, DATA_SCIENCE, WEB_DEVELOPMENT, CLOUD_COMPUTING, DEVOPS, CYBERSECURITY, BLOCKCHAIN, MOBILE_DEV
    * GIT, DOCKER, KUBERNETES, AWS, AZURE, SDLC, AGILE, TESTING
    * APTITUDE, LOGICAL_REASONING, ENGLISH, COMMUNICATION, BEHAVIORAL
    * ANY_LANGUAGE (technical but generic), GENERAL (non-technical)

* **curriculum_coverage:**
  * \`COVERED\`: concept/topic appears in curriculum context
  * \`NOT_COVERED\`: technical but not present in curriculum context
  * \`N/A\`: non-technical or insufficient curriculum context

### EXTRACTION RULES
* Always convert shorthand/keywords into complete interview questions.
* Keep \`question_text\` clear and grammatically correct.
* If round_text contains multiple prompts, return one item per question.
* Return only raw JSON. No markdown.
`;

const ROUND_COLUMN_MAP: Record<string, string> = {
  "Screening Questions": "Screening Round",
  "Assessment questions": "Assessment",
  "Technical round Questions": "Technical Round 1",
  "Technical2 round Questions": "Technical Round 2",
  "H.R Questions": "HR Round",
  "Cultural fit Round Questions": "Cultural Fit Round",
  "Managerial Round questions": "Managerial Round",
  "CEO/Founder/Director Round Questions": "CEO/Director Round",
};

const SHEET_HEADERS = [
  "job_id",
  "company_name",
  "user_id",
  "full_name",
  "mobile_number",
  "interview_round",
  "questions",
  "question_type",
  "tech_stacks",
  "topic",
  "sub_topic",
  "difficulty_level",
  "curriculum_coverage",
  "question_uid",
  "interview_date",
  "question_creation_datetime",
  "product",
];

type DrilldownAnalysisResult = {
  rows: Array<Record<string, string>>;
  savedToSheet: boolean;
  savedToBigQuery: boolean;
};

type StatusUpdateCallback = (
  message: string,
  payload?: JobUpdatePayload<DrilldownAnalysisResult>,
) => void;

const nowDate = (): string => new Date().toISOString().slice(0, 10);
const nowDateTime = (): string => new Date().toISOString().slice(0, 19).replace("T", " ");

const INVALID_ROUND_TEXT_VALUES = new Set([
  "nan",
  "no",
  "yes",
  "na",
  "n/a",
  "#n/a",
  "none",
  "null",
  "nil",
  "-",
  "--",
  "---",
  "not available",
  "not applicable",
]);

const INVALID_ROUND_TEXT_COMPACT = new Set([
  "nan",
  "no",
  "yes",
  "na",
  "none",
  "null",
  "nil",
  "notavailable",
  "notapplicable",
]);

const isValidRoundText = (value: unknown): boolean => {
  if (value === null || value === undefined) return false;
  const text = String(value).trim();
  if (!text) return false;
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  const compact = normalized.replace(/[^a-z0-9]/g, "");
  if (INVALID_ROUND_TEXT_VALUES.has(normalized)) return false;
  if (INVALID_ROUND_TEXT_COMPACT.has(compact)) return false;
  return true;
};

const extractQuestionText = (item: Record<string, unknown>): string => {
  const directCandidates = [
    item.question_text,
    item.questionText,
    item.question,
    item.text,
    item.prompt,
    item.formatted_question,
  ];

  for (const candidate of directCandidates) {
    const text = String(candidate ?? "").trim();
    if (text) return text;
  }

  const nestedQuestions = item.questions;
  if (Array.isArray(nestedQuestions)) {
    for (const nested of nestedQuestions) {
      if (typeof nested === "string" && nested.trim()) {
        return nested.trim();
      }
      if (typeof nested === "object" && nested !== null) {
        const nestedText = extractQuestionText(nested as Record<string, unknown>);
        if (nestedText) return nestedText;
      }
    }
  }

  return "";
};

const analyzeRound = async (
  runtime: ProviderRuntimeConfig,
  systemPrompt: string,
  roundName: string,
  roundText: string,
) => {
  const userContent = [
    "ROUND INPUT (JSON):",
    JSON.stringify({
      interview_round: roundName,
      round_text: roundText,
    }),
    "",
    "Convert raw notes into formatted interview questions and classify each question.",
  ].join("\n");

  const extracted = await aiJsonAsArray(
    runtime,
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    {
      responseAsJsonObject: true,
      temperature: 0.1,
    },
  );

  return extracted;
};

const analyzeCandidateRow = async (args: {
  row: Record<string, string>;
  rowIndex: number;
  totalRows: number;
  product: string;
  systemPrompt: string;
  takeRoundRuntime: () => ProviderRuntimeConfig;
  onStatus?: StatusUpdateCallback;
  abortIfCancelled?: () => void;
}): Promise<Array<Record<string, string>>> => {
  const { row, rowIndex, totalRows, product, systemPrompt, takeRoundRuntime, onStatus, abortIfCancelled } = args;
  const candidateNumber = rowIndex + 1;
  onStatus?.(`Analyzing candidate ${candidateNumber}/${totalRows}...`);

  const dateVal = (row["Interview Date"] || row.interview_date || nowDate()).trim();
  const userId = (row["User ID"] || row.user_id || "N/A").trim();
  const userName = (row["User Name"] || row.user_name || "N/A").trim();
  const mobile = (row["Mobile Number"] || row.mobile_number || "N/A").trim();
  const jobId = (row["Job ID"] || row.job_id || "N/A").trim();
  const company = (row["Company Name"] || row.company_name || "N/A").trim();

  const candidateRows: Array<Record<string, string>> = [];
  const roundIssues: string[] = [];
  let analyzedRoundCount = 0;

  for (const [columnName, roundName] of Object.entries(ROUND_COLUMN_MAP)) {
    abortIfCancelled?.();
    const rawRound = row[columnName];
    if (!isValidRoundText(rawRound)) continue;

    analyzedRoundCount += 1;
    onStatus?.(`Classifying ${roundName} for candidate ${candidateNumber}/${totalRows}...`);

    let extractedItems: Array<Record<string, unknown>> = [];
    try {
      const runtime = takeRoundRuntime();
      extractedItems = await analyzeRound(runtime, systemPrompt, roundName, String(rawRound));
    } catch (error) {
      roundIssues.push(`${roundName}: ${String(error)}`);
      onStatus?.(
        `Skipping ${roundName} for candidate ${candidateNumber}/${totalRows}: ${String(error)}`,
      );
      continue;
    }

    if (extractedItems.length === 0) {
      roundIssues.push(`${roundName}: model returned no parseable questions`);
      continue;
    }

    abortIfCancelled?.();
    let addedForRound = 0;
    for (const item of extractedItems) {
      const questionText = extractQuestionText(item);
      if (!questionText) continue;

      const questionType = forceEnumFormat(item.question_type ?? item.questionType ?? item.type ?? "GENERAL");
      const techStacks = forceEnumFormat(
        item.question_concept ?? item.tech_stacks ?? item.techStacks ?? item.category ?? "GENERAL",
      );
      const topic = forceEnumFormat(item.topic ?? item.main_topic ?? "N/A");
      const subTopic = forceEnumFormat(item.sub_topic ?? item.subTopic ?? "N/A");
      addedForRound += 1;

      candidateRows.push({
        job_id: jobId,
        company_name: company,
        user_id: userId,
        full_name: userName,
        mobile_number: mobile,
        interview_round: forceEnumFormat(roundName),
        questions: questionText,
        question_type: questionType,
        tech_stacks: techStacks,
        topic,
        sub_topic: subTopic,
        difficulty_level: forceEnumFormat(item.difficulty ?? item.difficulty_level ?? "MEDIUM"),
        curriculum_coverage: forceEnumFormat(item.curriculum_coverage ?? item.coverage ?? "N/A"),
        question_uid: randomUUID(),
        interview_date: dateVal,
        question_creation_datetime: nowDateTime(),
        product,
      });
    }

    if (addedForRound === 0) {
      roundIssues.push(`${roundName}: model output missing question_text`);
    }
  }

  if (analyzedRoundCount > 0 && candidateRows.length === 0) {
    const reason =
      roundIssues.length > 0
        ? roundIssues.slice(0, 4).join(" | ")
        : "Model returned empty output for all rounds";
    throw new Error(`No questions extracted for candidate ${candidateNumber}/${totalRows}. ${reason}`);
  }

  return candidateRows;
};

export const analyzeDrilldownRows = async (
  rows: Array<Record<string, string>>,
  product: string,
  provider: AiProvider,
  onStatus?: StatusUpdateCallback,
  abortIfCancelled?: () => void,
): Promise<DrilldownAnalysisResult> => {
  const orderRowsByHeaders = (rawRows: Array<Record<string, string>>): Array<Record<string, string>> => {
    return rawRows.map((row) => {
      const normalized: Record<string, string> = {};
      for (const header of SHEET_HEADERS) {
        normalized[header] = row[header] ?? "N/A";
      }
      return normalized;
    });
  };

  abortIfCancelled?.();
  onStatus?.("Loading curriculum context for drilldown...");
  const curriculumContext = await getCurriculumSnippet(15000);
  abortIfCancelled?.();
  const systemPrompt = DRILLDOWN_PROMPT_TEMPLATE.replace(
    "{{CURRICULUM_CONTEXT}}",
    curriculumContext.trim() || "N/A",
  );
  const storageSettings = await getStorageSettings();
  const baseRuntime = await getRuntimeProviderConfig(provider);
  const runtimePool =
    baseRuntime.provider === "mistral"
      ? (() => {
          const keys = baseRuntime.rotationApiKeys;
          if (keys.length === 0) {
            return [baseRuntime];
          }

          return keys.map((apiKey) => ({
            ...baseRuntime,
            apiKey,
          }));
        })()
      : [baseRuntime];
  let runtimeIndex = 0;
  const takeRoundRuntime = (): ProviderRuntimeConfig => {
    const runtime = runtimePool[runtimeIndex % runtimePool.length];
    runtimeIndex += 1;
    return runtime;
  };

  const totalRows = rows.length;
  const rowsByCandidateIndex: Array<Array<Record<string, string>> | null> = Array.from(
    { length: totalRows },
    () => null,
  );
  const workerCount = 1;

  const flattenCompletedRows = (): Array<Record<string, string>> => {
    const flattened: Array<Record<string, string>> = [];
    for (const candidateRows of rowsByCandidateIndex) {
      if (!candidateRows) continue;
      flattened.push(...candidateRows);
    }
    return flattened;
  };

  const sendProgress = (message: string): void => {
    if (!onStatus) return;
    const completedCandidates = rowsByCandidateIndex.reduce(
      (count, candidateRows) => (candidateRows ? count + 1 : count),
      0,
    );
    const percent = totalRows === 0 ? 100 : Math.round((completedCandidates / totalRows) * 100);
    onStatus(message, {
      progress: { percent },
      partialResult: {
        rows: orderRowsByHeaders(flattenCompletedRows()),
        savedToSheet: false,
        savedToBigQuery: false,
      },
    });
  };

  sendProgress("Starting drilldown analysis with 1 worker...");

  let nextRowIndex = 0;
  const skippedCandidates: string[] = [];

  const takeNextRowIndex = (): number | null => {
    if (nextRowIndex >= totalRows) {
      return null;
    }
    const current = nextRowIndex;
    nextRowIndex += 1;
    return current;
  };

  const runWorker = async (workerIndex: number): Promise<void> => {
    for (;;) {
      abortIfCancelled?.();
      const rowIndex = takeNextRowIndex();
      if (rowIndex === null) {
        return;
      }

      const candidateNumber = rowIndex + 1;
      onStatus?.(
        `Worker ${workerIndex + 1}/${workerCount}: analyzing candidate ${candidateNumber}/${totalRows}...`,
      );

      try {
        const candidateRows = await analyzeCandidateRow({
          row: rows[rowIndex],
          rowIndex,
          totalRows,
          product,
          systemPrompt,
          takeRoundRuntime,
          onStatus,
          abortIfCancelled,
        });
        rowsByCandidateIndex[rowIndex] = candidateRows;
        sendProgress(`Completed candidate ${candidateNumber}/${totalRows}.`);
      } catch (error) {
        const message = `Candidate ${candidateNumber}/${totalRows} skipped: ${String(error)}`;
        skippedCandidates.push(message);
        rowsByCandidateIndex[rowIndex] = [];
        onStatus?.(message);
        sendProgress(message);
      }
    }
  };

  await Promise.all(
    Array.from({ length: workerCount }, (_unused, workerIndex) => runWorker(workerIndex)),
  );

  if (skippedCandidates.length > 0) {
    onStatus?.(`Skipped ${skippedCandidates.length}/${totalRows} candidates due to parse issues.`);
  }

  const orderedRows = orderRowsByHeaders(flattenCompletedRows());

  if (rows.length > 0 && orderedRows.length === 0) {
    const firstIssue = skippedCandidates[0] ? ` First issue: ${skippedCandidates[0]}` : "";
    throw new Error(
      `No questions were extracted from drilldown input. Check round note quality and model JSON output.${firstIssue}`,
    );
  }

  abortIfCancelled?.();
  let savedToSheet = false;
  if (storageSettings.saveToSheets) {
    onStatus?.("Saving drilldown results to sheet...", {
      progress: { percent: 100 },
      partialResult: {
        rows: orderedRows,
        savedToSheet: false,
        savedToBigQuery: false,
      },
    });

    savedToSheet = await appendRowsWithHeaders({
      sheetName: SHEET_NAMES.drilldown,
      headers: SHEET_HEADERS,
      rows: orderedRows,
    });
  } else {
    onStatus?.("Sheet save is disabled in settings. Skipping sheet save.");
  }

  let savedToBigQuery = false;
  if (storageSettings.saveToBigQuery) {
    onStatus?.("Saving drilldown results to BigQuery...", {
      progress: { percent: 100 },
      partialResult: {
        rows: orderedRows,
        savedToSheet,
        savedToBigQuery: false,
      },
    });

    savedToBigQuery = await appendRowsToBigQuery({
      tableName: BIGQUERY_TABLE_NAMES.drilldown,
      rows: orderedRows,
    });
  } else {
    onStatus?.("BigQuery save is disabled in settings. Skipping BigQuery save.");
  }

  const anyStorageEnabled = storageSettings.saveToSheets || storageSettings.saveToBigQuery;
  const allRequestedSavesSucceeded =
    (!storageSettings.saveToSheets || savedToSheet) &&
    (!storageSettings.saveToBigQuery || savedToBigQuery);
  const completionMessage = !anyStorageEnabled
    ? "Drilldown analysis completed. Storage is disabled in settings."
    : allRequestedSavesSucceeded
      ? "Drilldown analysis completed."
      : "Drilldown completed, but one or more enabled storage targets failed.";

  onStatus?.(completionMessage, {
    progress: { percent: 100 },
    partialResult: {
      rows: orderedRows,
      savedToSheet,
      savedToBigQuery,
    },
  });

  return { rows: orderedRows, savedToSheet, savedToBigQuery };
};

export const getDrilldownSampleCsv = (): string => {
  return [
    "Interview Date,User ID,User Name,Mobile Number,Job ID,Company Name,Screening Questions,Assessment questions,Technical round Questions,Technical2 round Questions,H.R Questions,Cultural fit Round Questions,Managerial Round questions,CEO/Founder/Director Round Questions",
    "2023-01-01,U123,John,9999,J1,Google,Intro?,Test Link,Java Basics,System Design,Why us?,Values?,Manage Team?,Future goals?",
  ].join("\n");
};
