import { randomUUID } from "node:crypto";
import path from "node:path";
import AdmZip from "adm-zip";
import { getCurriculumSnippet } from "../utils/curriculum";
import { forceEnumFormat } from "../utils/enum";
import { appendRowsToBigQuery } from "../utils/bigquery";
import { appendRowsWithHeaders } from "../utils/google";
import { aiChatJson, aiJsonAsArray, aiOcr } from "../utils/aiProvider";
import { BIGQUERY_TABLE_NAMES, SHEET_NAMES } from "../config";
import type { AiProvider, AssessmentIndividualInput, AssessmentZipInput } from "../types";
import { getRuntimeProviderConfig, getStorageSettings, type ProviderRuntimeConfig } from "./settingsService";

const INITIAL_QUESTION_EXTRACTION_PROMPT = `
You are an Expert Technical Interview Data Extractor.
**YOUR TASK:** Extract questions strictly following these rules:

1.  **CLEAN TEXT:** Remove image placeholders like \`![image_id]\` and phrases like "Refer to image below".
2.  **MCQ Formatting:** Combine Question Text + ALL Options (A, B, C, D) into \`question_text\`.
3.  **Coding Formatting:** Extract ENTIRE problem description VERBATIM.
4.  **Handling Images:** If a diagram is crucial, set \`has_image\` to "Yes".

RAW TEXT:
{raw_text_safe}

**OUTPUT JSON:**
{
    "questions": [
        {
            "category": "General Tech Stack (e.g. Java, Aptitude, SQL, WebDev)",
            "question_text": "Cleaned question text...",
            "difficulty": "Easy/Medium/Hard",
            "has_image": "Yes/No"
        }
    ]
}
`;

const ASSESSMENT_CLASSIFICATION_PROMPT_TEMPLATE = `
### SYSTEM ROLE
You are a Senior Technical Curriculum Architect and Data Standardizer.
You will receive a JSON array of Q&A pairs. Your task is to classify, tag, and enrich each pair with standardized metadata.

### INPUT DATA
A list of objects containing \`question_text\` and \`answer_text\`.

### CURRICULUM CONTEXT
Use the following curriculum text to determine if a topic is covered in the syllabus:
{{CURRICULUM_CONTEXT}}

### CLASSIFICATION RULES

**1. OUTPUT STRUCTURE**
Return a JSON array where EACH item includes the original data plus new fields.
Required fields: \`question_text\`, \`question_type\`, \`question_concept\`, \`difficulty\`, \`topic\`, \`sub_topic\`,\`curriculum_coverage\`.

**2. ENUMERATION RULES (Use UPPERCASE_SNAKE_CASE)**

*   **question_type:**
    *   \`CODING\`: STRICTLY for questions requiring code writing, algorithms, queries, or syntax blocks.
    *   \`THEORY\`: Explaining concepts, definitions, "How would you...", comparisons.
    *   \`BEHAVIORAL\`: Soft skills, past experiences, situational.
    *   \`SELF_INTRODUCTION\`: Intro, resume walkthrough.
    *   \`PROJECT\`: Discussing specific past projects.
    *   \`GENERAL\`: Any other type.

*   **difficulty:**
    *   \`EASY\`: Basic definitions, recall, standard behavioral questions.
    *   \`MEDIUM\`: Implementation details, comparisons, explaining 'how' or 'why'.
    *   \`HARD\`: System design, optimization, edge cases, complex scenarios.

*   **curriculum_coverage:**
    *   \`COVERED\`: The specific concept appears in the provided Curriculum Context.
    *   \`NOT_COVERED\`: The concept is technical but NOT found in the context.
    *   \`N/A\`: For General/Behavioral questions or if context is missing.


**3. TECH STACK STANDARDIZATION (\`question_concept\`)**
Map the question to the *single best fit* from this list.
*   **Web Frontend:** HTML, CSS, BOOTSTRAP, JAVASCRIPT, TYPESCRIPT, REACT_JS, NEXT_JS.
*   **Web Backend:** NODE_JS, EXPRESS_JS, SPRING_BOOT, REST_API, PYTHON, JAVA.
*   **Data:** SQL, DATABASES, AI_ML, DATA_SCIENCE.
*   **CS Basics:** DSA, OOP, SYSTEM_DESIGN, OPERATING_SYSTEM, COMPUTER_NETWORKING.
*   **Tools/Other:** GIT, DOCKER, CLOUD_COMPUTING, AGILE, APTITUDE, ENGLISH, BEHAVIORAL.

**4. TOPIC & SUB_TOPIC (HIERARCHY RULES)**
*   **\`topic\`**: This must be a **CHAPTER** or **MODULE** inside the Tech Stack.
    *   *CRITICAL RULE:* \`topic\` MUST NOT be the same as \`question_concept\`.
    *   *Example (Wrong):* Tech: \`HTML\`, Topic: \`HTML\`.
    *   *Example (Right):* Tech: \`HTML\`, Topic: \`SEMANTIC_ELEMENTS\`.
    *   *Example (Right):* Tech: \`CSS\`, Topic: \`FLEXBOX\`.
*   **\`sub_topic\`**: The specific concept (e.g., "Justify Content", "Tags").

### OUTPUT FORMAT
Provide ONLY the raw JSON array. No markdown.
`;

const SHEET_HEADERS = [
  "job_id",
  "company_name",
  "questions",
  "question_type",
  "tech_stacks",
  "topic",
  "sub_topic",
  "difficulty_level",
  "curriculum_coverage",
  "question_uid",
  "assessment_date",
  "question_creation_datetime",
  "product",
];

const VALID_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".pdf", ".tiff", ".bmp"]);

const nowDateTime = (): string => new Date().toISOString().slice(0, 19).replace("T", " ");

type ExtractedQuestion = {
  category?: string;
  question_text?: string;
  difficulty?: string;
  has_image?: string;
  answer_text?: string;
  question_type?: string;
  question_concept?: string;
  topic?: string;
  sub_topic?: string;
  curriculum_coverage?: string;
};

const extractInitialQuestions = async (
  runtime: ProviderRuntimeConfig,
  rawText: string,
): Promise<ExtractedQuestion[]> => {
  if (!rawText || rawText.trim().length < 5) {
    return [];
  }

  const safeText = rawText.slice(0, 100000);
  const prompt = INITIAL_QUESTION_EXTRACTION_PROMPT.replace("{raw_text_safe}", safeText);

  const response = await aiChatJson(
    runtime,
    [{ role: "user", content: prompt }],
    { responseAsJsonObject: true, temperature: 0.1, timeoutMs: 90000 },
  );

  if (typeof response !== "object" || response === null) {
    return [];
  }

  const questions = Array.isArray((response as any).questions) ? (response as any).questions : [];
  return questions.map((item: any) => ({
    ...item,
    answer_text: "N/A",
  }));
};

const classifyExtractedQuestions = async (
  runtime: ProviderRuntimeConfig,
  qnaList: ExtractedQuestion[],
  curriculumContext: string,
  abortIfCancelled?: () => void,
): Promise<ExtractedQuestion[]> => {
  if (qnaList.length === 0) {
    return [];
  }

  const prompt = ASSESSMENT_CLASSIFICATION_PROMPT_TEMPLATE.replace(
    "{{CURRICULUM_CONTEXT}}",
    curriculumContext.slice(0, 15000),
  );

  const batchSize = 10;
  const merged: ExtractedQuestion[] = [];

  for (let index = 0; index < qnaList.length; index += batchSize) {
    abortIfCancelled?.();
    const batch = qnaList.slice(index, index + batchSize);
    const userContent = JSON.stringify(batch);

    const classified = await aiJsonAsArray(
      runtime,
      [
        { role: "system", content: prompt },
        { role: "user", content: userContent },
      ],
      { responseAsJsonObject: true, temperature: 0.1, timeoutMs: 90000 },
    );
    abortIfCancelled?.();

    for (const original of batch) {
      const match = classified.find(
        (candidate) => String(candidate.question_text ?? "") === String(original.question_text ?? ""),
      );

      const mergedRow: ExtractedQuestion = {
        ...original,
        ...(match ?? {}),
      };

      delete mergedRow.answer_text;
      merged.push(mergedRow);
    }
  }

  return merged;
};

const toFinalAssessmentRow = (args: {
  item: ExtractedQuestion;
  jobId: string;
  companyName: string;
  assessmentDate: string;
  product: string;
}): Record<string, string> => {
  const techStacks = args.item.question_concept ?? args.item.category ?? "Uncategorized";

  return {
    job_id: args.jobId,
    company_name: args.companyName,
    questions: String(args.item.question_text ?? ""),
    question_type: forceEnumFormat(args.item.question_type ?? "ASSESSMENT"),
    tech_stacks: forceEnumFormat(techStacks),
    topic: forceEnumFormat(args.item.topic ?? "N/A"),
    sub_topic: forceEnumFormat(args.item.sub_topic ?? "N/A"),
    difficulty_level: forceEnumFormat(args.item.difficulty ?? "MEDIUM"),
    curriculum_coverage: forceEnumFormat(args.item.curriculum_coverage ?? "N/A"),
    question_uid: randomUUID(),
    assessment_date: args.assessmentDate,
    question_creation_datetime: nowDateTime(),
    product: args.product,
  };
};

const processAssessmentFile = async (args: {
  fileName: string;
  fileBuffer: Buffer;
  mimeType?: string;
  runtime: ProviderRuntimeConfig;
  jobId: string;
  companyName: string;
  assessmentDate: string;
  product: string;
  curriculumContext: string;
  onStatus?: (message: string) => void;
  abortIfCancelled?: () => void;
}): Promise<Array<Record<string, string>>> => {
  args.abortIfCancelled?.();
  args.onStatus?.(`Running OCR for ${args.fileName}...`);
  const ocr = await aiOcr(args.runtime, {
    fileName: args.fileName,
    fileBuffer: args.fileBuffer,
    mimeType: args.mimeType,
  });
  args.abortIfCancelled?.();

  if (!ocr.fullText) {
    return [];
  }

  args.onStatus?.(`Extracting questions from ${args.fileName}...`);
  const initialQuestions = await extractInitialQuestions(args.runtime, ocr.fullText);
  args.abortIfCancelled?.();
  if (initialQuestions.length === 0) {
    return [];
  }

  args.onStatus?.(`Classifying questions from ${args.fileName}...`);
  const classified = await classifyExtractedQuestions(
    args.runtime,
    initialQuestions,
    args.curriculumContext,
    args.abortIfCancelled,
  );
  args.abortIfCancelled?.();
  return classified.map((item) =>
    toFinalAssessmentRow({
      item,
      jobId: args.jobId,
      companyName: args.companyName,
      assessmentDate: args.assessmentDate,
      product: args.product,
    }),
  );
};

const orderRows = (rows: Array<Record<string, string>>): Array<Record<string, string>> => {
  return rows.map((row) => {
    const ordered: Record<string, string> = {};
    for (const header of SHEET_HEADERS) {
      ordered[header] = row[header] ?? "N/A";
    }
    return ordered;
  });
};

export const analyzeAssessmentIndividual = async (args: {
  rows: AssessmentIndividualInput[];
  files: Map<string, Express.Multer.File>;
  product: string;
  provider: AiProvider;
  onStatus?: (message: string) => void;
  abortIfCancelled?: () => void;
}): Promise<{ rows: Array<Record<string, string>>; savedToSheet: boolean; savedToBigQuery: boolean }> => {
  args.abortIfCancelled?.();
  const runtime = await getRuntimeProviderConfig(args.provider);
  const storageSettings = await getStorageSettings();
  args.onStatus?.("Loading curriculum context...");
  const curriculumContext = await getCurriculumSnippet(15000);
  args.abortIfCancelled?.();
  const finalRows: Array<Record<string, string>> = [];
  const total = args.rows.length;
  let processed = 0;

  for (const row of args.rows) {
    args.abortIfCancelled?.();
    const file = args.files.get(row.fileField);
    if (!file) continue;
    processed += 1;
    args.onStatus?.(`Processing assessment file ${processed}/${total}...`);

    const extracted = await processAssessmentFile({
      fileName: file.originalname,
      fileBuffer: file.buffer,
      mimeType: file.mimetype,
      runtime,
      jobId: row.job_id?.trim() || "N/A",
      companyName: row.company_name?.trim() || "N/A",
      assessmentDate: row.assessment_date || new Date().toISOString().slice(0, 10),
      product: args.product,
      curriculumContext,
      onStatus: args.onStatus,
      abortIfCancelled: args.abortIfCancelled,
    });

    args.abortIfCancelled?.();
    finalRows.push(...extracted);
  }

  const orderedRows = orderRows(finalRows);
  args.abortIfCancelled?.();
  let savedToSheet = false;
  if (storageSettings.saveToSheets) {
    args.onStatus?.("Saving assessment results to sheet...");
    savedToSheet = await appendRowsWithHeaders({
      sheetName: SHEET_NAMES.assessments,
      headers: SHEET_HEADERS,
      rows: orderedRows,
    });
  } else {
    args.onStatus?.("Sheet save is disabled in settings. Skipping sheet save.");
  }

  let savedToBigQuery = false;
  if (storageSettings.saveToBigQuery) {
    args.onStatus?.("Saving assessment results to BigQuery...");
    savedToBigQuery = await appendRowsToBigQuery({
      tableName: BIGQUERY_TABLE_NAMES.assessments,
      rows: orderedRows,
    });
  } else {
    args.onStatus?.("BigQuery save is disabled in settings. Skipping BigQuery save.");
  }

  return { rows: orderedRows, savedToSheet, savedToBigQuery };
};

export const analyzeAssessmentZip = async (args: {
  rows: AssessmentZipInput[];
  files: Map<string, Express.Multer.File>;
  product: string;
  provider: AiProvider;
  onStatus?: (message: string) => void;
  abortIfCancelled?: () => void;
}): Promise<{ rows: Array<Record<string, string>>; savedToSheet: boolean; savedToBigQuery: boolean }> => {
  args.abortIfCancelled?.();
  const runtime = await getRuntimeProviderConfig(args.provider);
  const storageSettings = await getStorageSettings();
  args.onStatus?.("Loading curriculum context...");
  const curriculumContext = await getCurriculumSnippet(15000);
  args.abortIfCancelled?.();
  const finalRows: Array<Record<string, string>> = [];
  const total = args.rows.length;
  let processedZip = 0;

  for (const row of args.rows) {
    args.abortIfCancelled?.();
    const zipFile = args.files.get(row.fileField);
    if (!zipFile) continue;
    processedZip += 1;
    args.onStatus?.(`Reading ZIP ${processedZip}/${total}...`);

    const zip = new AdmZip(zipFile.buffer);
    const entries = zip
      .getEntries()
      .filter((entry) => !entry.isDirectory)
      .filter((entry) => VALID_EXTENSIONS.has(path.extname(entry.entryName).toLowerCase()));
    const totalEntries = entries.length;
    let entryIndex = 0;

    for (const entry of entries) {
      args.abortIfCancelled?.();
      entryIndex += 1;
      args.onStatus?.(`Processing ZIP file ${entryIndex}/${totalEntries}: ${path.basename(entry.entryName)}...`);
      const fileBuffer = entry.getData();
      const extracted = await processAssessmentFile({
        fileName: path.basename(entry.entryName),
        fileBuffer,
        runtime,
        jobId: row.job_id?.trim() || "N/A",
        companyName: row.company_name?.trim() || "N/A",
        assessmentDate: row.assessment_date || new Date().toISOString().slice(0, 10),
        product: args.product,
        curriculumContext,
        onStatus: args.onStatus,
        abortIfCancelled: args.abortIfCancelled,
      });

      args.abortIfCancelled?.();
      finalRows.push(...extracted);
    }
  }

  const orderedRows = orderRows(finalRows);
  args.abortIfCancelled?.();
  let savedToSheet = false;
  if (storageSettings.saveToSheets) {
    args.onStatus?.("Saving assessment results to sheet...");
    savedToSheet = await appendRowsWithHeaders({
      sheetName: SHEET_NAMES.assessments,
      headers: SHEET_HEADERS,
      rows: orderedRows,
    });
  } else {
    args.onStatus?.("Sheet save is disabled in settings. Skipping sheet save.");
  }

  let savedToBigQuery = false;
  if (storageSettings.saveToBigQuery) {
    args.onStatus?.("Saving assessment results to BigQuery...");
    savedToBigQuery = await appendRowsToBigQuery({
      tableName: BIGQUERY_TABLE_NAMES.assessments,
      rows: orderedRows,
    });
  } else {
    args.onStatus?.("BigQuery save is disabled in settings. Skipping BigQuery save.");
  }

  return { rows: orderedRows, savedToSheet, savedToBigQuery };
};
