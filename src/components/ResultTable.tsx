import "./ResultTable.css";

type ResultTableProps = {
  rows: Array<Record<string, string>>;
  maxHeight?: number;
};

const getHeaders = (rows: Array<Record<string, string>>): string[] => {
  if (rows.length === 0) return [];
  return Object.keys(rows[0]);
};

export function ResultTable({ rows, maxHeight = 460 }: ResultTableProps) {
  if (rows.length === 0) {
    return <div className="result-empty">No rows to display.</div>;
  }

  const headers = getHeaders(rows);

  return (
    <div className="result-table-wrap" style={{ maxHeight }}>
      <table className="result-table">
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={`${rowIndex}-${row.question_uid ?? "row"}`}>
              {headers.map((header) => (
                <td key={`${rowIndex}-${header}`}>{row[header] ?? ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
