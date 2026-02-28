export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type AiProvider = "mistral" | "openai";

export type ProductOption =
  | "Intensive"
  | "Academy"
  | "External"
  | "Academy Edge"
  | "Nxtwave Edge"
  | "NIAT"
  | "Intensive Offline"
  | "Experienced Hiring";

export type QaItem = {
  question_text: string;
  answer_text?: string;
  question_type?: string;
  question_concept?: string;
  difficulty?: string;
  topic?: string;
  sub_topic?: string;
  relevancy_score?: string;
  curriculum_coverage?: string;
};

export type DrilldownInputRow = Record<string, string>;

export type AssessmentZipInput = {
  company_name: string;
  job_id: string;
  assessment_date: string;
  fileField: string;
};

export type AssessmentIndividualInput = {
  company_name: string;
  job_id: string;
  assessment_date: string;
  fileField: string;
};

export type AssignmentInputRow = {
  job_id: string;
  company_name: string;
  assignment_link: string;
  assignment_date: string;
};

export type InterviewInputRow = {
  user_id: string;
  fullName: string;
  MobileNumber: string;
  interview_round: string;
  drive_file_id: string;
  job_id: string;
  company_name: string;
  interview_date: string;
  clip_start_time?: string | number | null;
  clip_end_time?: string | number | null;
};

export type VideoUploaderMetadata = {
  user_id: string;
  fullName: string;
  MobileNumber: string;
  interview_round: string;
  drive_file_id?: string;
  job_id: string;
  company_name: string;
  interview_date: string;
  clip_start_time?: string | number | null;
  clip_end_time?: string | number | null;
};
