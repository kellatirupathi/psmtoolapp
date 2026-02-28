import fs from "node:fs";
import path from "node:path";

let cachedCurriculumText: string | null = null;

export const getCurriculumText = async (): Promise<string> => {
  if (cachedCurriculumText !== null) {
    return cachedCurriculumText;
  }

  const configuredPath = process.env.CURRICULUM_PATH?.trim();
  const textPath = configuredPath && configuredPath.length > 0
    ? configuredPath
    : path.resolve(process.cwd(), "curriculum.txt");
  if (!fs.existsSync(textPath)) {
    cachedCurriculumText = "";
    return cachedCurriculumText;
  }

  try {
    cachedCurriculumText = fs.readFileSync(textPath, "utf8").trim();
  } catch {
    cachedCurriculumText = "";
  }

  return cachedCurriculumText ?? "";
};

export const getCurriculumSnippet = async (maxLength = 15000): Promise<string> => {
  const text = await getCurriculumText();
  return text.slice(0, maxLength);
};
