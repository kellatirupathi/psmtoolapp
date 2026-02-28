export const rowsToCsv = (rows: Array<Record<string, string>>): string => {
  if (rows.length === 0) return "";

  const headers = Object.keys(rows[0]);
  const lines: string[] = [headers.join(",")];

  for (const row of rows) {
    const line = headers
      .map((header) => {
        const raw = String(row[header] ?? "");
        if (raw.includes(",") || raw.includes("\n") || raw.includes('"')) {
          return `"${raw.replace(/"/g, '""')}"`;
        }
        return raw;
      })
      .join(",");

    lines.push(line);
  }

  return lines.join("\n");
};

export const downloadCsv = (fileName: string, csvContent: string): void => {
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.setAttribute("download", fileName);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};
