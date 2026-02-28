import { downloadCsv, rowsToCsv } from "../utils/csv";
import type { ValidationIssue, ValidationReport } from "../utils/validators";
import "./ValidationPanel.css";

type ValidationPanelProps<T> = {
  report: ValidationReport<T> | null;
  title?: string;
  maxIssuesToShow?: number;
  fileName?: string;
};

const issuesToRows = (issues: ValidationIssue[]): Array<Record<string, string>> =>
  issues.map((issue) => ({
    row: String(issue.row),
    column: issue.column,
    severity: issue.severity,
    message: issue.message,
    value: issue.value ?? "",
  }));

export function ValidationPanel<T>({
  report,
  title = "Pre-flight Validation",
  maxIssuesToShow = 20,
  fileName = "validation_issues.csv",
}: ValidationPanelProps<T>) {
  if (!report || report.summary.total === 0) {
    return null;
  }

  const visibleIssues = report.issues.slice(0, maxIssuesToShow);
  const hasIssues = report.issues.length > 0;
  const statusClass = report.summary.errors > 0 ? "error" : "ok";

  return (
    <section className={`validation-panel ${statusClass}`}>
      <div className="validation-header">
        <h4>{title}</h4>
        {hasIssues && (
          <button
            className="secondary-button"
            onClick={() => downloadCsv(fileName, rowsToCsv(issuesToRows(report.issues)))}
            type="button"
          >
            Download Issues CSV
          </button>
        )}
      </div>

      <div className="validation-summary">
        <span>Total: {report.summary.total}</span>
        <span>Valid: {report.summary.valid}</span>
        <span>Invalid: {report.summary.invalid}</span>
        <span>Errors: {report.summary.errors}</span>
        <span>Warnings: {report.summary.warnings}</span>
      </div>

      {!hasIssues ? (
        <div className="validation-ok">No issues found. Input is ready.</div>
      ) : (
        <>
          <div className="validation-note">
            Showing {visibleIssues.length} of {report.issues.length} issue(s).
          </div>
          <div className="validation-table-wrap">
            <table className="validation-table">
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Column</th>
                  <th>Severity</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {visibleIssues.map((issue, index) => (
                  <tr key={`${issue.row}-${issue.column}-${index}`}>
                    <td>{issue.row}</td>
                    <td>{issue.column}</td>
                    <td>{issue.severity.toUpperCase()}</td>
                    <td>{issue.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

