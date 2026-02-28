import { useEffect, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./DocumentationPage.css";

type DocumentationModeId = "interview" | "drilldown" | "assessments" | "assignments";

type DocumentationMode = {
  id: DocumentationModeId;
  label: string;
  markdown: string;
};

const templateSheetUrl =
  "https://docs.google.com/spreadsheets/d/10rLUKCucmgrLSS--TgW8dP8zpkeN_ugIjkDlvgAOpMU/edit?gid=1586920339#gid=1586920339";

const productSelectorMarkdown = `
## Product Selector (Global)

**Input Type:** Dropdown  
**Field:** \`product\`

Available values:

- Intensive
- Academy
- External
- Academy Edge
- Nxtwave Edge
- NIAT
- Intensive Offline
- Experienced Hiring
`;

const documentationModes: DocumentationMode[] = [
  {
    id: "interview",
    label: "Interview Analyser",
    markdown: `
## Drive-Based Interview Analyzer

### Input Method 1: Paste Text (Tab Separated)

Accepted columns: **7 / 8 / 9 columns**  
Recommended format:

~~~
user_id	fullName	MobileNumber	interview_round	drive_file_id	job_id	company_name	clip_start_time	clip_end_time
~~~

Example:

~~~
U123	John Doe	9876543210	1	1gfZvlSqDriveID	JOB01	Google	0	300
~~~

### Input Method 2: Upload CSV

Mandatory column:

- drive_file_id

Optional columns:

- user_id
- fullName
- MobileNumber
- interview_round
- job_id
- company_name
- clip_start_time
- clip_end_time

## Video Uploader (Local File)

### Step 1: Paste metadata (Tab Separated)

~~~
user_id	fullName	MobileNumber	interview_round	drive_file_id	job_id	company_name	clip_start_time	clip_end_time
~~~

Example:

~~~
U123	John Doe	9876543210	1	Local	JOB01	Google	0	600
~~~

### Step 2: Upload video file

Supported formats:

- mp4
- mov
- avi
- mkv
- webm
`,
  },
  {
    id: "drilldown",
    label: "Drilldown",
    markdown: `
## Input: Upload CSV

### Mandatory columns

~~~
Interview Date
User ID
User Name
Mobile Number
Job ID
Company Name
~~~

### Round columns (any of these)

~~~
Screening Questions
Assessment questions
Technical round Questions
Technical2 round Questions
H.R Questions
Cultural fit Round Questions
Managerial Round questions
CEO/Founder/Director Round Questions
~~~
`,
  },
  {
    id: "assessments",
    label: "Assessments",
    markdown: `
## ZIP File Processor

For each company row:

- \`company_name\`: Text
- \`job_id\`: Text
- \`assessment_date\`: Date
- \`uploaded_zip_file\`: \`.zip\`

Supported files inside ZIP:

- PDF
- PNG
- JPG
- JPEG
- WEBP
- TIFF
- BMP

## Individual File Processor

For each row:

- \`job_id\`: Text
- \`company_name\`: Text
- \`assessment_date\`: Date
- \`uploaded_file\`: PDF / PNG / JPG / JPEG / WEBP / TIFF / BMP
`,
  },
  {
    id: "assignments",
    label: "Assignments",
    markdown: `
## Paste Text (Tab Separated)

~~~
job_id	company_name	assignment_link	assignment_date
~~~

Example:

~~~
JOB123	Google	https://docs.google.com/...	2023-10-27
~~~

## Upload CSV

Required columns:

~~~
job_id
company_name
assignment_link
assignment_date
~~~
`,
  },
];

const flattenText = (node: ReactNode): string => {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map((item) => flattenText(item)).join(" ");
  }

  if (node && typeof node === "object" && "props" in node) {
    const maybeProps = (node as { props?: { children?: ReactNode } }).props;
    return flattenText(maybeProps?.children ?? "");
  }

  return "";
};

const slugify = (value: string): string => {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
};

export function DocumentationPage() {
  const [selectedMode, setSelectedMode] = useState<DocumentationModeId>("interview");
  const currentMode =
    documentationModes.find((mode) => mode.id === selectedMode) ?? documentationModes[0];

  useEffect(() => {
    document.body.classList.add("docs-body");

    return () => {
      document.body.classList.remove("docs-body");
    };
  }, []);

  return (
    <div className="docs-shell">
      <main className="docs-main">
        <header className="docs-topbar">
          <h1>PsmTool Documentation</h1>
          <a href="/" className="docs-home-link">
            Open App
          </a>
        </header>

        <section className="docs-layout">
          <aside className="docs-sidebar" aria-label="Documentation modes">
            <p className="docs-sidebar-title">Modes</p>
            {documentationModes.map((mode) => {
              const isActive = mode.id === currentMode.id;
              return (
                <button
                  type="button"
                  key={mode.id}
                  className={`docs-mode-button${isActive ? " active" : ""}`}
                  onClick={() => setSelectedMode(mode.id)}
                >
                  {mode.label}
                </button>
              );
            })}
          </aside>

          <article className="docs-card">
            <section className="docs-template-card" aria-label="Template sheet">
              <h2>Template Sheet</h2>
              <p>Use this sheet template while preparing documentation input data.</p>
              <a href={templateSheetUrl} target="_blank" rel="noreferrer">
                Open Template Sheet
              </a>
            </section>

            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                h1: ({ children }) => {
                  const id = slugify(flattenText(children));
                  return <h1 id={id}>{children}</h1>;
                },
                h2: ({ children }) => {
                  const id = slugify(flattenText(children));
                  return <h2 id={id}>{children}</h2>;
                },
                h3: ({ children }) => {
                  const id = slugify(flattenText(children));
                  return <h3 id={id}>{children}</h3>;
                },
              }}
            >
              {`# ${currentMode.label}\n\n${productSelectorMarkdown}\n\n${currentMode.markdown}`}
            </ReactMarkdown>
          </article>
        </section>
      </main>
    </div>
  );
}
