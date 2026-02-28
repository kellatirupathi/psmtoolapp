import { GITHUB_GIST_TOKEN } from "../config";

const GIST_API_URL = "https://api.github.com/gists";

export const createPublicGist = async (fileName: string, content: string): Promise<string> => {
  if (!GITHUB_GIST_TOKEN) {
    return "Gist Token Missing";
  }

  try {
    const response = await fetch(GIST_API_URL, {
      method: "POST",
      headers: {
        Authorization: `token ${GITHUB_GIST_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        description: `Transcript for ${fileName}`,
        public: true,
        files: {
          [fileName]: {
            content,
          },
        },
      }),
    });

    if (response.status === 201) {
      const json: any = await response.json();
      return String(json?.html_url ?? "Error retrieving URL");
    }

    return `Error: ${response.status}`;
  } catch (error) {
    return `Upload Failed: ${String(error)}`;
  }
};
