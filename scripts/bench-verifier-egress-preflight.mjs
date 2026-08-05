#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const proxyRouteKeys = Object.freeze([
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
  "http_proxy", "https_proxy", "all_proxy"
]);
const proxyEnvironmentKeys = Object.freeze([
  ...proxyRouteKeys,
  "NO_PROXY", "no_proxy"
]);
const defaultImage = "ubuntu:24.04";
const defaultHttpsUrl = "https://example.com/";
const maximumParallelism = 4;
const maximumRounds = 5;
const maximumAttempts = 3;
const maximumAttemptBackoffMs = 30_000;
const defaultMaxAttempts = 2;
const defaultAttemptBackoffMs = 2_000;
const outputTailLimit = 64 * 1024;

function positiveInteger(value, fallback, maximum, label) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${maximum}.`);
  }
  return parsed;
}

function nonNegativeInteger(value, fallback, maximum, label) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new Error(`${label} must be an integer between 0 and ${maximum}.`);
  }
  return parsed;
}

function sha256(value, label) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = String(value).trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) throw new Error(`${label} must be a SHA-256 digest.`);
  return normalized;
}

function httpsUrl(value) {
  const parsed = new URL(value ?? defaultHttpsUrl);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("--https-url must be a credential-free HTTPS URL.");
  }
  return parsed.href;
}

function containerImage(value) {
  const image = String(value ?? defaultImage).trim();
  if (!image || !/^[a-zA-Z0-9][a-zA-Z0-9./:@_-]*$/u.test(image)) {
    throw new Error("--image must be a plain container image reference.");
  }
  return image;
}

export function parseVerifierEgressPreflightArgs(argv, env = process.env) {
  const values = {};
  const allowed = new Set([
    "--expected-self-sha256", "--https-url", "--image", "--parallelism", "--rounds",
    "--max-attempts", "--attempt-backoff-ms"
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!allowed.has(key)) throw new Error(`Unknown option: ${String(key)}`);
    if (index + 1 >= argv.length) throw new Error(`${key} requires a value.`);
    values[key] = argv[index + 1];
  }
  return {
    expectedSelfSha256: sha256(values["--expected-self-sha256"], "--expected-self-sha256"),
    httpsUrl: httpsUrl(values["--https-url"]),
    image: containerImage(values["--image"] ?? env.SIGMA_VERIFIER_PREFLIGHT_IMAGE),
    parallelism: positiveInteger(
      values["--parallelism"] ?? env.SIGMA_VERIFIER_CONCURRENCY,
      1,
      maximumParallelism,
      "preflight parallelism"
    ),
    rounds: positiveInteger(
      values["--rounds"] ?? env.SIGMA_VERIFIER_PREFLIGHT_ROUNDS,
      1,
      maximumRounds,
      "preflight rounds"
    ),
    maxAttempts: positiveInteger(
      values["--max-attempts"] ?? env.SIGMA_VERIFIER_PREFLIGHT_MAX_ATTEMPTS,
      defaultMaxAttempts,
      maximumAttempts,
      "preflight max attempts"
    ),
    attemptBackoffMs: nonNegativeInteger(
      values["--attempt-backoff-ms"] ?? env.SIGMA_VERIFIER_PREFLIGHT_ATTEMPT_BACKOFF_MS,
      defaultAttemptBackoffMs,
      maximumAttemptBackoffMs,
      "preflight attempt backoff ms"
    )
  };
}

export function verifierEgressPreflightSelfSha256() {
  return createHash("sha256").update(readFileSync(scriptPath)).digest("hex");
}

export function assertVerifierEgressPreflightSelfSha256(expected) {
  if (!expected) return verifierEgressPreflightSelfSha256();
  const observed = verifierEgressPreflightSelfSha256();
  if (observed !== expected) {
    throw new Error(`Verifier egress preflight SHA-256 ${observed} does not match ${expected}.`);
  }
  return observed;
}

const bootstrapScript = [
  "export DEBIAN_FRONTEND=noninteractive",
  "apt-get -qq -o Acquire::Retries=0 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 update",
  "apt-get -qq -o Acquire::Retries=0 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 install -y --no-install-recommends ca-certificates curl >/dev/null",
  "iteration=0",
  "while [ \"$iteration\" -lt \"$1\" ]; do",
  "  curl --fail --silent --show-error --location --connect-timeout 15 --max-time 60 \"$2\" -o /dev/null",
  "  iteration=$((iteration + 1))",
  "done"
].join("\n");

function safeEnvironmentValue(value, key) {
  const text = String(value);
  if (text.includes("\0") || /[\r\n]/u.test(text)) {
    throw new Error(`${key} must not contain NUL or line breaks.`);
  }
  return text;
}

export function buildVerifierEgressDockerArgs(options, env = process.env) {
  const args = ["run", "--rm", "--pull=never", "--network", "bridge"];
  for (const key of proxyEnvironmentKeys) {
    if (!Object.hasOwn(env, key)) continue;
    args.push("-e", `${key}=${safeEnvironmentValue(env[key], key)}`);
  }
  args.push(
    options.image,
    "sh", "-ceu", bootstrapScript,
    "sigma-verifier-egress-preflight",
    String(options.rounds),
    options.httpsUrl
  );
  return args;
}

function appendTail(current, chunk) {
  const combined = `${current}${String(chunk)}`;
  return combined.length <= outputTailLimit ? combined : combined.slice(-outputTailLimit);
}

function runDockerWorker(command, args, worker) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout = appendTail(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = appendTail(stderr, chunk); });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ worker, code, signal, stdout, stderr }));
  });
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function workerFailure(result) {
  return result.error || result.code !== 0 || result.signal;
}

function workerErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= outputTailLimit ? message : message.slice(-outputTailLimit);
}

async function runWorker(runner, dockerCommand, args, worker) {
  try {
    return await runner(dockerCommand, args, worker);
  } catch (error) {
    return {
      worker,
      code: null,
      signal: null,
      stdout: "",
      stderr: "",
      error: workerErrorMessage(error)
    };
  }
}

export async function runVerifierEgressPreflight(
  options,
  env = process.env,
  runner = runDockerWorker,
  sleeper = wait
) {
  const dockerCommand = env.SIGMA_DOCKER_COMMAND || "docker";
  const args = buildVerifierEgressDockerArgs(options, env);
  const startedAt = Date.now();
  const attemptResults = [];
  let lastFailureCount = options.parallelism;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    const attemptStartedAt = Date.now();
    const results = await Promise.all(Array.from(
      { length: options.parallelism },
      (_, worker) => runWorker(runner, dockerCommand, args, worker + 1)
    ));
    const failed = results.filter(workerFailure);
    lastFailureCount = failed.length;
    attemptResults.push({
      attempt,
      status: failed.length === 0 ? "passed" : "failed",
      elapsed_ms: Date.now() - attemptStartedAt,
      failed_workers: failed.map((result) => ({
        worker: result.worker,
        exit_code: result.code,
        signal: result.signal ?? null,
        spawn_error: Boolean(result.error)
      }))
    });

    if (failed.length === 0) {
      return {
        schemaVersion: 1,
        status: "passed",
        image: options.image,
        parallelism: options.parallelism,
        rounds: options.rounds,
        max_attempts: options.maxAttempts,
        attempts_used: attempt,
        additional_attempts_used: attempt - 1,
        attempt_results: attemptResults,
        elapsed_ms: Date.now() - startedAt,
        proxy_environment: proxyRouteKeys.some((key) => Boolean(env[key]))
          ? "configured" : "absent"
      };
    }

    for (const result of failed) {
      process.stderr.write([
        `attempt ${attempt}/${options.maxAttempts}, worker ${result.worker} failed `
          + `(exit=${String(result.code)}, signal=${String(result.signal)})`,
        result.error,
        result.stdout.trim(),
        result.stderr.trim()
      ].filter(Boolean).join("\n") + "\n");
    }
    if (attempt < options.maxAttempts) {
      const delayMs = Math.min(
        options.attemptBackoffMs * (2 ** (attempt - 1)),
        maximumAttemptBackoffMs
      );
      process.stderr.write(
        `starting another full ${options.parallelism}-worker preflight cohort in ${delayMs} ms\n`
      );
      await sleeper(delayMs);
    }
  }

  throw new Error(
    `${lastFailureCount}/${options.parallelism} verifier egress preflight workers failed `
      + `after ${options.maxAttempts} attempts.`
  );
}

async function main() {
  const options = parseVerifierEgressPreflightArgs(process.argv.slice(2));
  assertVerifierEgressPreflightSelfSha256(options.expectedSelfSha256);
  const result = await runVerifierEgressPreflight(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === scriptPath;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
