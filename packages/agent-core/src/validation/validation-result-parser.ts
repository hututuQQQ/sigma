export interface ParsedValidationDiagnostic {
  file?: string;
  line?: number;
  column?: number;
  severity: "error" | "warning" | "info";
  message: string;
}

export function parseValidationDiagnostics(text: string): ParsedValidationDiagnostic[] {
  const diagnostics: ParsedValidationDiagnostic[] = [];
  for (const line of text.split(/\r?\n/)) {
    const ts = line.match(/^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+([^:]+):\s+(.+)$/);
    if (ts) {
      diagnostics.push({
        file: ts[1],
        line: Number(ts[2]),
        column: Number(ts[3]),
        severity: ts[4] === "warning" ? "warning" : "error",
        message: `${ts[5]}: ${ts[6]}`
      });
      continue;
    }
    const colon = line.match(/^(.+?):(\d+):(?:(\d+):)?\s*(.+)$/);
    if (colon && /(failed|error|assert|syntaxerror|traceback|panic|undefined|cannot|expected)/i.test(line)) {
      diagnostics.push({
        file: colon[1],
        line: Number(colon[2]),
        ...(colon[3] ? { column: Number(colon[3]) } : {}),
        severity: "error",
        message: colon[4]
      });
    }
  }
  return diagnostics.slice(0, 50);
}
