import { access, readFile } from "node:fs/promises";
import path from "node:path";

function containedPath(workspace, relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0 || relativePath.includes("\\")) {
    throw new Error(`Invalid portable relative path: ${JSON.stringify(relativePath)}`);
  }
  const root = path.resolve(workspace);
  const candidate = path.resolve(root, ...relativePath.split("/"));
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Path escapes workspace: ${relativePath}`);
  return candidate;
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    throw error;
  }
}

async function verifyFile(workspace, rule) {
  const filePath = containedPath(workspace, rule.path);
  const exists = await fileExists(filePath);
  if (rule.exists === false) {
    if (exists) throw new Error(`${rule.path} should not exist`);
    return;
  }
  if (!exists) throw new Error(`${rule.path} does not exist`);
  if (!["equals", "contains", "notContains"].some((key) => Object.hasOwn(rule, key))) return;
  const content = await readFile(filePath, "utf8");
  if (Object.hasOwn(rule, "equals") && content !== rule.equals) throw new Error(`${rule.path} did not match its exact expected content`);
  if (Object.hasOwn(rule, "contains") && !content.includes(rule.contains)) throw new Error(`${rule.path} did not contain the expected text`);
  if (Object.hasOwn(rule, "notContains") && content.includes(rule.notContains)) throw new Error(`${rule.path} contained forbidden text`);
}

async function main() {
  const [workspace, specPath] = process.argv.slice(2);
  if (!workspace || !specPath) throw new Error("Usage: verify-workspace.mjs <workspace> <verifier.json>");
  const spec = JSON.parse(await readFile(path.resolve(specPath), "utf8"));
  if (!Array.isArray(spec.files) || spec.files.length === 0) throw new Error("Verifier spec must contain a non-empty files array");
  for (const rule of spec.files) await verifyFile(workspace, rule);
  process.stdout.write(`${JSON.stringify({ ok: true, checkedFiles: spec.files.length })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
