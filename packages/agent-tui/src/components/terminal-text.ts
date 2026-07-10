const regexCodePoint = (hex: string): string => `\\u${hex}`;
const escapeCode = regexCodePoint("001b");
const bellCode = regexCodePoint("0007");
const oscPattern = new RegExp(`${escapeCode}\\][^${bellCode}]*(?:${bellCode}|${escapeCode}\\\\)`, "gu");
const csiPattern = new RegExp(`${escapeCode}\\[[0-?]*[ -/]*[@-~]`, "gu");
const escapePattern = new RegExp(`${escapeCode}[@-_]`, "gu");
const controlPattern = new RegExp(
  `[${regexCodePoint("0000")}-${regexCodePoint("0008")}${regexCodePoint("000b")}-${regexCodePoint("001f")}${regexCodePoint("007f")}]`,
  "gu"
);

export function sanitizeTerminalText(value: string): string {
  return value
    .replace(oscPattern, "")
    .replace(csiPattern, "")
    .replace(escapePattern, "")
    .replace(/\t/gu, "    ")
    .replace(controlPattern, "�");
}

export function compactLine(value: string, maximum = 160): string {
  const normalized = sanitizeTerminalText(value).replace(/\s+/gu, " ").trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, Math.max(0, maximum - 1))}…`;
}
