#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import spawn from "cross-spawn";

const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/u;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function npmCommand(platform = process.platform) {
  return platform === "win32" ? "npm.cmd" : "npm";
}

export function normalizedProxyEnv(env = process.env) {
  const next = { ...env };
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
    const value = next[key];
    if (typeof value === "string" && /^htpp:\/\//i.test(value)) {
      next[key] = `http://${value.slice(7)}`;
    }
  }
  return next;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });
}

async function writeExclusive(filePath, bytes) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const handle = await open(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function packageCodexRuntime(options, deps = {}) {
  const version = String(options?.version ?? "").trim();
  if (!VERSION.test(version)) throw new Error("A concrete Codex --version is required.");
  const output = path.resolve(String(options?.output ?? ""));
  if (!options?.output) throw new Error("--output is required.");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "sigma-codex-runtime-"));
  try {
    const packageId = `@openai/codex@${version}-linux-x64`;
    const runner = deps.run ?? run;
    const result = await runner(npmCommand(deps.platform), [
      "pack", packageId, "--pack-destination", temporary, "--json"
    ], { cwd: temporary, env: normalizedProxyEnv(deps.env ?? process.env) });
    if (result.exitCode !== 0) {
      throw new Error(`npm pack failed for ${packageId}: ${String(result.stderr).trim()}`);
    }
    let records;
    try {
      records = JSON.parse(String(result.stdout));
    } catch (error) {
      throw new Error("npm pack did not return JSON metadata.", { cause: error });
    }
    if (!Array.isArray(records) || records.length !== 1) {
      throw new Error("npm pack returned an unexpected package set.");
    }
    const record = records[0];
    const expectedBinary = "vendor/x86_64-unknown-linux-musl/bin/codex";
    if (record.id !== packageId || record.version !== `${version}-linux-x64`
      || !Array.isArray(record.files)
      || !record.files.some((file) => file?.path === expectedBinary && file?.mode === 493)) {
      throw new Error("The Codex npm archive lacks the expected executable Linux runtime.");
    }
    const sourcePath = path.join(temporary, path.basename(String(record.filename ?? "")));
    const bytes = await readFile(sourcePath);
    await writeExclusive(output, bytes);
    const metadata = {
      schemaVersion: 1,
      kind: "CodexRuntimeArchive",
      package: packageId,
      version,
      target: "x86_64-unknown-linux-musl",
      layout: "npm-linux-x64",
      npm_integrity: record.integrity ?? null,
      npm_shasum: record.shasum ?? null,
      bytes: bytes.length,
      sha256: sha256(bytes),
      archive: path.basename(output)
    };
    if (options.metadataOutput) {
      await writeExclusive(
        path.resolve(options.metadataOutput),
        Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`)
      );
    }
    return { output, metadata };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function cliOptions(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!["--version", "--output", "--metadata-output"].includes(name)) {
      throw new Error(`Unsupported option: ${name}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
    result[name.slice(2).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase())] = value;
    index += 1;
  }
  return result;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) packageCodexRuntime(cliOptions(process.argv.slice(2))).then(({ output, metadata }) => {
  process.stdout.write(`${JSON.stringify({ output, ...metadata })}\n`);
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
