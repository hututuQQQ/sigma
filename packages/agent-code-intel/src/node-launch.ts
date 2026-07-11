import path from "node:path";
import { NODE_CHILD_PROCESS_DENIAL_BOOTSTRAP } from "agent-execution";

// LPAC intentionally cannot inspect ancestors outside declared read roots.
// Node's realpath implementation walks to the volume root before opening a
// declared path, so a read-only language server needs a lexical EPERM fallback.
// The native sandbox remains authoritative: following a link outside an ACL'd
// root is still denied by the OS. Other realpath failures remain fatal.
const NODE_LSP_BOOTSTRAP = String.raw`
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
const denied = (error) => error && error.code === "EPERM";
const inputPath = (value) => value instanceof URL ? fileURLToPath(value)
  : Buffer.isBuffer(value) ? value.toString() : String(value);
const lexical = (value) => path.resolve(inputPath(value));
const normalized = (value) => process.platform === "win32"
  ? lexical(value).toLowerCase() : lexical(value);
const within = (root, candidate) => {
  const relative = path.relative(normalized(root), normalized(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep)
    && !path.isAbsolute(relative));
};
const entry = path.resolve(process.argv[1]);
${NODE_CHILD_PROCESS_DENIAL_BOOTSTRAP}
let declaredRoots = [];
try {
  const value = JSON.parse(process.env.SIGMA_LSP_READ_ROOTS ?? "[]");
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) declaredRoots = value;
} catch {}
const roots = [...new Set([
  process.cwd(), path.dirname(entry), process.env.TEMP, process.env.TMP, ...declaredRoots
].filter(Boolean).map((item) => path.resolve(item)))];
const related = (value) => roots.some((root) => within(root, lexical(value)) || within(lexical(value), root));
const ancestor = (value) => roots.some((root) => normalized(root) !== normalized(value)
  && within(lexical(value), root));
const encoded = (value, options) => {
  const resolved = lexical(value);
  const encoding = typeof options === "string" ? options : options?.encoding;
  return encoding === "buffer" ? Buffer.from(resolved) : resolved;
};
const originalSync = fs.realpathSync.bind(fs);
const compatibleSync = (value, options) => {
  try { return originalSync(value, options); }
  catch (error) { if (!denied(error) || !related(value)) throw error; return encoded(value, options); }
};
compatibleSync.native = compatibleSync;
fs.realpathSync = compatibleSync;
const originalCallback = fs.realpath.bind(fs);
const compatibleCallback = (value, options, done) => {
  const callback = typeof options === "function" ? options : done;
  const encoding = typeof options === "function" ? undefined : options;
  originalCallback(value, encoding, (error, result) => {
    if (error && denied(error) && related(value)) callback(null, encoded(value, encoding));
    else callback(error, result);
  });
};
compatibleCallback.native = compatibleCallback;
fs.realpath = compatibleCallback;
const originalPromise = fs.promises.realpath.bind(fs.promises);
fs.promises.realpath = async (value, options) => {
  try { return await originalPromise(value, options); }
  catch (error) { if (!denied(error) || !related(value)) throw error; return encoded(value, options); }
};
const originalStatSync = fs.statSync.bind(fs);
const originalLstatSync = fs.lstatSync.bind(fs);
const directoryStats = originalStatSync(process.cwd());
const compatibleStatSync = (original) => (value, options) => {
  try { return original(value, options); }
  catch (error) { if (!denied(error) || !ancestor(value)) throw error; return directoryStats; }
};
fs.statSync = compatibleStatSync(originalStatSync);
fs.lstatSync = compatibleStatSync(originalLstatSync);
const compatibleStatCallback = (original) => (value, options, done) => {
  const callback = typeof options === "function" ? options : done;
  const statOptions = typeof options === "function" ? undefined : options;
  original(value, statOptions, (error, result) => {
    if (error && denied(error) && ancestor(value)) callback(null, directoryStats);
    else callback(error, result);
  });
};
fs.stat = compatibleStatCallback(fs.stat.bind(fs));
fs.lstat = compatibleStatCallback(fs.lstat.bind(fs));
const compatibleStatPromise = (original) => async (value, options) => {
  try { return await original(value, options); }
  catch (error) { if (!denied(error) || !ancestor(value)) throw error; return directoryStats; }
};
fs.promises.stat = compatibleStatPromise(fs.promises.stat.bind(fs.promises));
fs.promises.lstat = compatibleStatPromise(fs.promises.lstat.bind(fs.promises));
syncBuiltinESMExports();
process.argv = [
  process.execPath,
  entry,
  ...process.argv.slice(2).filter((argument) => argument !== "--sigma-lsp-deny-child-process")
];
await import(pathToFileURL(entry).href);
`;

export interface NodeLanguageServerArgumentsOptions {
  /** Prevent a server from creating worker processes that the required sandbox intentionally denies. */
  foregroundOnly?: boolean;
}

export function nodeLanguageServerArguments(
  entry: string,
  options: NodeLanguageServerArgumentsOptions = {}
): string[] {
  return [
    ...(options.foregroundOnly === true ? ["--debug-port=0"] : []),
    "--preserve-symlinks",
    "--input-type=module",
    "--eval",
    NODE_LSP_BOOTSTRAP,
    path.resolve(entry),
    ...(options.foregroundOnly === true ? ["--sigma-lsp-deny-child-process"] : []),
    "--stdio"
  ];
}
