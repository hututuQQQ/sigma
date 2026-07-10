import { SyntaxStyle } from "@opentui/core";

export interface TuiTheme {
  noColor: boolean;
  brand?: string;
  prompt?: string;
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
    brand: "#52c7c4",
    prompt: "#ff7a83",
    accent: "#52c7c4",
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
