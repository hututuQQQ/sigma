import path from "node:path";

const ignoredDirectories = new Set([
  ".agent", ".agents", ".artifacts", ".cache", ".codex", ".cursor", ".git", ".github",
  ".hg", ".gradle", ".mypy_cache", ".next", ".nuxt", ".openai", ".pytest_cache",
  ".ruff_cache", ".svn", ".turbo", ".venv", ".yarn", "__pycache__", "build", "coverage",
  "dist", "node_modules", "obj", "out", "target", "vendor", "venv"
]);
const agentControlFiles = new Set([
  "agents.md", "claude.md", "copilot-instructions.md", "gemini.md"
]);
const sensitiveFileNames = new Set([
  "auth.json", "credentials", "credentials.json", "dockerconfigjson", "id_dsa", "id_ecdsa",
  "id_ed25519", "id_rsa", "netrc", "npmrc", "nuget.config", "pip.conf", "pypirc", "secret",
  "secret.json", "secrets", "secrets.json", "service-account.json", "service_account.json",
  "settings.xml", "terraform.tfstate", "terraform.tfstate.backup", "token", "token.json",
  "tokens", "tokens.json"
]);
const sensitiveExtensions = new Set([
  ".der", ".env", ".jks", ".kdbx", ".key", ".keystore", ".ovpn", ".p12", ".pem", ".pfx",
  ".tfstate"
]);

function hiddenName(name: string): boolean {
  return name.startsWith(".");
}

function matchesSensitiveName(name: string, values: ReadonlySet<string>): boolean {
  for (const value of values) {
    if (name === value || name.startsWith(`${value}.`) || name.startsWith(`${value}~`)) {
      return true;
    }
  }
  return false;
}

function hasSensitiveExtension(name: string): boolean {
  for (const extension of sensitiveExtensions) {
    if (name.endsWith(extension) || name.includes(`${extension}.`)
      || name.includes(`${extension}~`)) return true;
  }
  return false;
}

function sensitivePathName(name: string): boolean {
  return matchesSensitiveName(name, sensitiveFileNames) || hasSensitiveExtension(name);
}

export function ignoredDirectory(name: string): boolean {
  const normalized = name.toLowerCase();
  return hiddenName(name) || ignoredDirectories.has(normalized)
    || matchesSensitiveName(normalized, agentControlFiles) || sensitivePathName(normalized);
}

export function safeAutomaticFileName(name: string): boolean {
  if (!name || name.includes("/") || name.includes("\\")) return false;
  const normalized = name.toLowerCase();
  return !hiddenName(name) && !matchesSensitiveName(normalized, agentControlFiles)
    && !sensitivePathName(normalized);
}

export function safeAutomaticFilePath(file: string): boolean {
  if (!file || path.isAbsolute(file) || /^[a-z]:/iu.test(file)) return false;
  const segments = file.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return false;
  const basename = segments.at(-1);
  return basename !== undefined
    && segments.slice(0, -1).every((segment) => !ignoredDirectory(segment))
    && safeAutomaticFileName(basename);
}

export function safeAutomaticDirectoryPath(directory: string): boolean {
  if (directory === ".") return true;
  if (!directory || path.isAbsolute(directory) || /^[a-z]:/iu.test(directory)) return false;
  const segments = directory.replaceAll("\\", "/").split("/");
  return segments.every((segment) => segment && segment !== "." && segment !== ".."
    && !ignoredDirectory(segment));
}
