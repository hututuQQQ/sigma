import { glyphs, supportsUnicode } from "./theme.js";

const VERSION = "v0.1.0";

export function sigmaBrandName(): string {
  return `${glyphs().sigma} sigma`;
}

export function sigmaTagline(): string {
  const g = glyphs();
  return `sum the repo ${g.separator} ship the patch`;
}

export function sigmaLockup(): string[] {
  return [
    `  ${sigmaBrandName()}`,
    `  ${sigmaTagline()}`
  ];
}

export interface SigmaWelcomeOptions {
  provider?: string;
  model?: string;
  workspacePath: string;
}

function providerLabel(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized === "deepseek") return "DeepSeek";
  if (normalized === "glm") return "GLM";
  return value.length === 0 ? value : `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

export function sigmaWelcome(options: SigmaWelcomeOptions): string[] {
  const g = glyphs();
  const provider = providerLabel(options.provider ?? "deepseek");
  const model = options.model ?? "default";
  if (!supportsUnicode()) {
    return [
      "  SSSSSSSSSSS",
      `        SS        S Sigma Code ${VERSION}`,
      `      SS          ${provider} ${g.separator} ${model}`,
      `    SS            ${options.workspacePath}`,
      "      SS",
      "        SS",
      "  SSSSSSSSSSS"
    ];
  }
  return [
    "  \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588",
    `        \u2588\u2588        ${g.sigma} Sigma Code ${VERSION}`,
    `      \u2588\u2588          ${provider} ${g.separator} ${model}`,
    `    \u2588\u2588            ${options.workspacePath}`,
    "      \u2588\u2588",
    "        \u2588\u2588",
    "  \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588"
  ];
}
