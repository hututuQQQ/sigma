import { SyntaxStyle } from "@opentui/core";

export interface TuiTheme {
  noColor: boolean;
  accent?: string;
  success?: string;
  warning?: string;
  error?: string;
  muted?: string;
  selection?: string;
  syntax: SyntaxStyle;
}

export function createTuiTheme(noColor: boolean): TuiTheme {
  const colors = noColor ? {} : {
    accent: "#5fd7ff",
    success: "#87d787",
    warning: "#ffd75f",
    error: "#ff5f5f",
    muted: "#8a8a8a",
    selection: "#444444"
  };
  const syntax = SyntaxStyle.fromStyles(noColor ? { default: {} } : {
    default: {},
    "markup.heading": { fg: colors.accent, bold: true },
    "markup.heading.1": { fg: colors.accent, bold: true },
    "markup.heading.2": { fg: colors.accent, bold: true },
    "markup.list": { fg: colors.warning },
    "markup.raw": { fg: colors.success },
    "markup.link": { fg: colors.accent, underline: true },
    "markup.bold": { bold: true },
    "markup.italic": { italic: true },
    "comment": { fg: colors.muted, italic: true },
    "string": { fg: colors.success },
    "keyword": { fg: colors.accent, bold: true }
  });
  return { noColor, ...colors, syntax };
}
