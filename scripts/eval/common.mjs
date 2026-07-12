import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const evalRootDir = path.join(rootDir, ".artifacts", "eval");
export const fixtureRootDir = path.join(rootDir, "test-fixtures", "agent-evals");
export const cliEntry = path.join(rootDir, "packages", "agent-cli", "dist", "index.js");

export function parseArgs(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      result._.push(token);
      continue;
    }
    const separator = token.indexOf("=");
    if (separator >= 0) {
      result[token.slice(2, separator)] = token.slice(separator + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      result[key] = next;
      index += 1;
    } else {
      result[key] = true;
    }
  }
  return result;
}

export function positiveInteger(value, fallback, label) {
  if (value === undefined || value === null || value === true || value === "") return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function digest(value) {
  const input = typeof value === "string" || Buffer.isBuffer(value) ? value : canonicalJson(value);
  return createHash("sha256").update(input).digest("hex");
}

export function makeRunId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/u, "Z");
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

function parseEnvValue(raw) {
  const value = raw.trim();
  const quoted = /^(?:"([\s\S]*)"|'([\s\S]*)')$/u.exec(value);
  return quoted ? quoted[1] ?? quoted[2] ?? "" : value;
}

export function loadEvalSecrets(filePath = path.join(rootDir, ".env")) {
  const allowed = new Set(["DEEPSEEK_API_KEY"]);
  const values = {};
  if (existsSync(filePath)) {
    for (const rawLine of readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "").split(/\r?\n/u)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u.exec(rawLine);
      if (!match || rawLine.trimStart().startsWith("#") || !allowed.has(match[1])) continue;
      values[match[1]] = parseEnvValue(match[2]);
    }
  }
  if (!values.DEEPSEEK_API_KEY?.trim()) throw new Error(`Missing DEEPSEEK_API_KEY in ${filePath}.`);
  return values;
}

const SECRET_ENV_KEY = /(?:api[_-]?key|token|secret|password|passwd|credential|private[_-]?key|authorization|cookie)/iu;

export function artifactSecretValues(subjectSecrets, base = process.env) {
  const candidates = [
    ...Object.values(subjectSecrets ?? {}),
    ...Object.entries(base)
      .filter(([key]) => SECRET_ENV_KEY.test(key))
      .map(([, value]) => value)
  ];
  return [...new Set(candidates.filter((value) => typeof value === "string" && value.length >= 4))];
}

const SAFE_ENV_KEYS = new Set([
  "ALLUSERSPROFILE", "APPDATA", "COMSPEC", "CommonProgramFiles", "CommonProgramFiles(x86)",
  "CommonProgramW6432", "DriverData", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "NUMBER_OF_PROCESSORS",
  "OS", "PATH", "PATHEXT", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "PROCESSOR_LEVEL",
  "PROCESSOR_REVISION", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "PSModulePath",
  "PUBLIC", "SystemDrive", "SystemRoot", "TEMP", "TMP", "USERDOMAIN", "USERNAME", "WINDIR",
  "LANG", "LC_ALL", "TERM", "SHELL"
]);
const SAFE_ENV_KEYS_CASE_INSENSITIVE = new Set([...SAFE_ENV_KEYS].map((key) => key.toUpperCase()));
const ISOLATED_ENV_KEYS = new Set([
  "APPDATA", "HOME", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "SIGMA_STATE_HOME",
  "TEMP", "TMP", "TMPDIR", "USERPROFILE", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"
]);

export function subjectEnvironment({ stateHome, homeDir, tempDir = path.join(homeDir, "tmp"), secrets, base = process.env }) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    // Windows environment names are case-insensitive and commonly expose
    // `Path`, while Node and child tools may look up `PATH`. Preserve the host
    // spelling but compare case-insensitively so the isolated subject retains
    // its executable search path without inheriting unrelated credentials.
    const normalizedKey = key.toUpperCase();
    if (!ISOLATED_ENV_KEYS.has(normalizedKey)
      && SAFE_ENV_KEYS_CASE_INSENSITIVE.has(normalizedKey)
      && typeof value === "string") env[key] = value;
  }
  const appData = path.join(homeDir, "AppData", "Roaming");
  const localAppData = path.join(homeDir, "AppData", "Local");
  Object.assign(env, {
    HOME: homeDir,
    USERPROFILE: homeDir,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    TEMP: tempDir,
    TMP: tempDir,
    TMPDIR: tempDir,
    XDG_CACHE_HOME: path.join(homeDir, ".cache"),
    XDG_CONFIG_HOME: path.join(homeDir, ".config"),
    XDG_DATA_HOME: path.join(homeDir, ".local", "share"),
    SIGMA_STATE_HOME: stateHome,
    DEEPSEEK_API_KEY: secrets.DEEPSEEK_API_KEY,
    CI: "1",
    NO_COLOR: "1",
    SIGMA_NO_COLOR: "1",
    TERM: env.TERM || "xterm-256color"
  });
  return env;
}

export function createRedactor(secretValues) {
  const values = [...new Set(secretValues.filter((value) => typeof value === "string" && value.length >= 4))]
    .sort((left, right) => right.length - left.length);
  return (input) => values.reduce((text, secret) => text.split(secret).join("[REDACTED]"), String(input ?? ""));
}

export async function writeJson(filePath, value, redactor = String) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(filePath, redactor(content), "utf8");
}

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export function relativeArtifact(runDir, filePath) {
  return path.relative(runDir, filePath).replace(/\\/gu, "/");
}
