export const INTERVIEW_QUESTION_TYPES = [
  "CODING",
  "THEORY",
  "BEHAVIORAL",
  "SELF_INTRODUCTION",
  "PROJECT",
  "GENERAL",
] as const;

export const INTERVIEW_DIFFICULTIES = ["EASY", "MEDIUM", "HARD"] as const;
export const INTERVIEW_TECH_NON_TECH = ["TECH", "NON_TECH"] as const;
export const INTERVIEW_CURRICULUM_COVERAGE = ["COVERED", "NOT_COVERED", "N/A"] as const;

export const INTERVIEW_CONCEPTS = [
  "HTML", "CSS", "SASS", "TAILWIND_CSS", "BOOTSTRAP", "MATERIAL_UI", "CHAKRA_UI",
  "JAVASCRIPT", "TYPESCRIPT", "REACT_JS", "NEXT_JS", "ANGULAR", "VUE_JS", "REDUX",
  "NODE_JS", "EXPRESS_JS", "NEST_JS", "SPRING_BOOT", "DJANGO", "FLASK", "FASTAPI",
  "DOTNET", "ASP_NET", "LARAVEL", "REST_API", "GRAPHQL", "JAVA", "PYTHON", "CPP", "C",
  "CSHARP", "GO", "RUST", "PHP", "RUBY", "SWIFT", "KOTLIN", "SQL", "MYSQL",
  "POSTGRESQL", "MONGODB", "REDIS", "SQLITE", "ORACLE_DB", "FIREBASE", "SUPABASE",
  "ELASTICSEARCH", "CASSANDRA", "AI_ML", "MACHINE_LEARNING", "DEEP_LEARNING", "NLP",
  "COMPUTER_VISION", "GEN_AI", "LLM", "DATA_SCIENCE", "PANDAS", "NUMPY", "SCIKIT_LEARN",
  "TENSORFLOW", "PYTORCH", "AWS", "AZURE", "GCP", "CLOUD_COMPUTING", "DOCKER",
  "KUBERNETES", "TERRAFORM", "JENKINS", "GITHUB_ACTIONS", "CI_CD", "NGINX", "LINUX",
  "CYBERSECURITY", "NETWORK_SECURITY", "OWASP", "PENETRATION_TESTING", "ANDROID", "IOS",
  "FLUTTER", "REACT_NATIVE", "UI_UX", "FIGMA", "SOFTWARE_TESTING", "MANUAL_TESTING",
  "AUTOMATION_TESTING", "API_TESTING", "PERFORMANCE_TESTING", "SELENIUM", "CYPRESS",
  "PLAYWRIGHT", "POSTMAN", "DSA", "OOP", "SYSTEM_DESIGN", "OPERATING_SYSTEM",
  "COMPUTER_NETWORKING", "GIT", "GITHUB", "JIRA", "AGILE", "APTITUDE", "ENGLISH",
  "BEHAVIORAL", "GENERAL",
] as const;

const strictObject = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});

export const INTERVIEW_QNA_RESPONSE_SCHEMA = strictObject(
  {
    items: {
      type: "array",
      items: strictObject(
        {
          question_text: { type: "string" },
          answer_text: { type: "string" },
        },
        ["question_text", "answer_text"],
      ),
    },
  },
  ["items"],
);

export const INTERVIEW_CLASSIFICATION_RESPONSE_SCHEMA = strictObject(
  {
    items: {
      type: "array",
      items: strictObject(
        {
          item_id: { type: "integer" },
          question_text: { type: "string" },
          answer_text: { type: "string" },
          question_type: { type: "string", enum: [...INTERVIEW_QUESTION_TYPES] },
          question_concept: { type: "string", enum: [...INTERVIEW_CONCEPTS] },
          tech_non_tech: { type: "string", enum: [...INTERVIEW_TECH_NON_TECH] },
          difficulty: { type: "string", enum: [...INTERVIEW_DIFFICULTIES] },
          topic: { type: "string" },
          sub_topic: { type: "string" },
          relevancy_score: {
            type: "string",
            enum: ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
          },
          curriculum_coverage: { type: "string", enum: [...INTERVIEW_CURRICULUM_COVERAGE] },
        },
        [
          "item_id",
          "question_text",
          "answer_text",
          "question_type",
          "question_concept",
          "tech_non_tech",
          "difficulty",
          "topic",
          "sub_topic",
          "relevancy_score",
          "curriculum_coverage",
        ],
      ),
    },
  },
  ["items"],
);
