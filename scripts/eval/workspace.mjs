import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, lstat, mkdir, readFile, readdir, readlink, rm, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";

function run(command, args, cwd, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode: exitCode ?? 1, stdout, stderr }));
  });
}

async function mustRun(command, args, cwd) {
  const result = await run(command, args, cwd);
  if (result.exitCode !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.exitCode}): ${result.stderr || result.stdout}`);
  }
  return result;
}

function safeRelative(value, label = "workspace path") {
  if (typeof value !== "string" || !value || path.isAbsolute(value)) throw new Error(`Invalid ${label}: ${String(value)}`);
  const normalized = value.replace(/\\/gu, "/");
  if (normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Unsafe ${label}: ${value}`);
  }
  return normalized;
}

async function applySetupOperation(workspace, operation) {
  const relative = safeRelative(operation.path, "setup path");
  const target = path.join(workspace, ...relative.split("/"));
  if (operation.type === "delete") {
    await rm(target, { recursive: true, force: true });
    return;
  }
  await mkdir(path.dirname(target), { recursive: true });
  if (operation.type === "append") await appendFile(target, String(operation.content ?? ""), "utf8");
  else if (operation.type === "write") await writeFile(target, String(operation.content ?? ""), "utf8");
  else throw new Error(`Unsupported setup operation '${String(operation.type)}'.`);
}

export async function seedWorkspace({ attemptRoot, fixtureDirectory, setupAfterCommit = [] }) {
  const workspaceParent = path.join(attemptRoot, "subject");
  const workspace = path.join(workspaceParent, `workspace-${randomUUID()}`);
  await mkdir(workspaceParent, { recursive: true });
  await cp(fixtureDirectory, workspace, { recursive: true, force: false, errorOnExist: true });
  await mustRun("git", ["init", "--quiet"], workspace);
  await mustRun("git", ["config", "user.name", "Workspace User"], workspace);
  await mustRun("git", ["config", "user.email", "workspace-user@example.invalid"], workspace);
  await mustRun("git", ["add", "--all"], workspace);
  await mustRun("git", ["commit", "--quiet", "-m", "initial workspace"], workspace);
  for (const operation of setupAfterCommit) await applySetupOperation(workspace, operation);
  return workspace;
}

async function visit(root, current, result) {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).replace(/\\/gu, "/");
    const info = await lstat(absolute);
    if (relative === ".git" && info.isDirectory()) {
      for (const metadataPath of ["HEAD", "config", "packed-refs"]) {
        const metadataTarget = path.join(absolute, metadataPath);
        const metadata = await lstat(metadataTarget).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
        if (!metadata?.isFile()) continue;
        const content = await readFile(metadataTarget);
        result[`.git/${metadataPath}`] = {
          kind: "file", size: content.length, mode: metadata.mode & 0o7777,
          digest: createHash("sha256").update(content).digest("hex")
        };
      }
      continue;
    }
    if (info.isSymbolicLink()) {
      result[relative] = { kind: "symlink", target: await readlink(absolute) };
      continue;
    }
    if (info.isDirectory()) {
      result[`${relative}/`] = { kind: "directory" };
      await visit(root, absolute, result);
      continue;
    }
    if (!info.isFile()) continue;
    const content = await readFile(absolute);
    result[relative] = {
      kind: "file",
      size: content.length,
      mode: info.mode & 0o7777,
      digest: createHash("sha256").update(content).digest("hex")
    };
  }
}

export async function snapshotWorkspace(workspace) {
  const entries = {};
  await visit(workspace, workspace, entries);
  return entries;
}

export function diffWorkspaceSnapshots(before, after) {
  const added = [];
  const modified = [];
  const deleted = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of [...keys].sort()) {
    if (!(key in before)) added.push(key);
    else if (!(key in after)) deleted.push(key);
    else if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) modified.push(key);
  }
  return { added, modified, deleted };
}

function globRegex(pattern) {
  const normalized = pattern.replace(/\\/gu, "/");
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === "*" && normalized[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
  }
  return new RegExp(`^${source}$`, "u");
}

export function pathAllowed(relativePath, patterns) {
  const normalized = relativePath.replace(/\\/gu, "/").replace(/\/$/u, "");
  return patterns.some((pattern) => globRegex(pattern).test(normalized));
}

export function unauthorizedChanges(delta, allowedPatterns) {
  return [...new Set([...delta.added, ...delta.modified, ...delta.deleted])]
    .filter((item) => !pathAllowed(item, allowedPatterns));
}

export async function gitDiff(workspace) {
  const status = await run("git", ["status", "--short", "--untracked-files=all"], workspace);
  const diff = await run("git", ["diff", "--binary", "HEAD"], workspace);
  return {
    status: status.stdout,
    diff: diff.stdout,
    diagnostics: [status, diff].filter((item) => item.exitCode !== 0).map((item) => item.stderr || item.stdout)
  };
}

export { safeRelative };
