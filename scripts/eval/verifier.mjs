import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { safeRelative, unauthorizedChanges } from "./workspace.mjs";

const DEFAULT_TIMEOUT_MS = 120_000;
const OUTPUT_LIMIT = 2 * 1024 * 1024;

function substitute(value, variables) {
  return String(value).replace(/\$(WORKSPACE|MANIFEST_DIR)/gu, (_match, key) => variables[key]);
}

async function connectVerifierBroker(context) {
  if (!context.brokerPath) throw new Error("A target-native sigma-exec broker is required for command verification.");
  if (!context.nodePath) throw new Error("A verified Node runtime is required for command verification.");
  const api = await import("../../packages/agent-execution/dist/index.js");
  const broker = new api.SigmaExecBrokerClient({
    helperPath: context.brokerPath,
    sandboxMode: "required",
    trustedToolchains: [verifierNodeToolchain(context.nodePath, api)],
    secrets: context.secrets
  });
  await broker.connect();
  return broker;
}

export function verifierNodeToolchain(nodePath, api, platform = process.platform) {
  if (!path.isAbsolute(nodePath)) throw new Error("Verifier Node runtime must be absolute.");
  const toolchain = {
    id: "eval-verifier-node",
    runtime: "node",
    executable: path.resolve(nodePath),
    aliases: platform === "win32" ? ["node", "node.exe"] : ["node"],
    executionRoots: [path.resolve(nodePath)],
    pathEntries: []
  };
  if (platform !== "win32") return toolchain;
  if (typeof api?.createWindowsAppContainerNodeCompatibilityProof !== "function"
    || typeof api?.WINDOWS_APPCONTAINER_NODE_COMPATIBILITY?.requiredNodeOptions !== "string") {
    throw new Error("Windows verifier Node compatibility support is unavailable.");
  }
  return {
    ...toolchain,
    environment: {
      NODE_OPTIONS: api.WINDOWS_APPCONTAINER_NODE_COMPATIBILITY.requiredNodeOptions
    },
    compatibility: api.createWindowsAppContainerNodeCompatibilityProof(
      toolchain.executable,
      toolchain.id
    )
  };
}

async function execute(broker, executable, args, options) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const result = await broker.execute({
    command: {
      executable,
      args,
      cwd: options.cwd,
      environment: {
        overrides: {
          HOME: options.home,
          USERPROFILE: options.home,
          TEMP: options.home,
          TMP: options.home,
          CI: "1",
          NO_COLOR: "1"
        }
      }
    },
    policy: {
      sandbox: "required",
      network: "none",
      readRoots: [...new Set([options.workspace, options.manifestDir, path.dirname(executable), options.home])],
      writeRoots: [options.workspace, options.home]
    },
    timeoutMs,
    maxOutputBytes: OUTPUT_LIMIT
  }, { timeoutMs: timeoutMs + 10_000 });
  return {
    exitCode: result.exitCode ?? 1,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
    outputTruncated: result.outputTruncated
  };
}

function isContained(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function workspaceFile(workspace, relative) {
  const root = await realpath(workspace);
  const parts = relative.split("/");
  let target = root;
  let info = null;
  for (const [index, part] of parts.entries()) {
    target = path.join(target, part);
    info = await lstat(target).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (!info) return { target, info: null };
    if (info.isSymbolicLink()) throw new Error(`${parts.slice(0, index + 1).join("/")} is a symbolic link or junction.`);
    const resolved = await realpath(target);
    if (!isContained(root, resolved)) throw new Error(`${parts.slice(0, index + 1).join("/")} resolves outside the verifier workspace.`);
    if (index < parts.length - 1 && !info.isDirectory()) {
      throw new Error(`${parts.slice(0, index + 1).join("/")} is not a directory.`);
    }
  }
  return { target, info };
}

function stringList(value) {
  if (Array.isArray(value)) return value;
  return typeof value === "string" ? [value] : [];
}

function jsonFileFailure(check, content) {
  if (check.json === undefined) return [];
  try {
    return JSON.stringify(JSON.parse(content)) === JSON.stringify(check.json) ? [] : ["JSON value did not match"];
  } catch {
    return ["file was not valid JSON"];
  }
}

function fileContentFailures(check, content) {
  const failures = [];
  if (typeof check.content === "string" && content !== check.content) failures.push("content did not match exactly");
  if (typeof check.equals === "string" && content !== check.equals) failures.push("content did not match exactly");
  for (const expected of stringList(check.contains)) {
    if (!content.includes(expected)) failures.push(`missing expected text ${JSON.stringify(expected)}`);
  }
  for (const forbidden of stringList(check.notContains)) {
    if (content.includes(forbidden)) failures.push(`contained forbidden text ${JSON.stringify(forbidden)}`);
  }
  if (typeof check.matches === "string" && !new RegExp(check.matches, check.flags ?? "u").test(content)) {
    failures.push("content did not match regex");
  }
  failures.push(...jsonFileFailure(check, content));
  return failures;
}

async function fileCheck(check, workspace) {
  const relative = safeRelative(check.path, "verifier file path");
  let target;
  let info;
  try {
    ({ target, info } = await workspaceFile(workspace, relative));
  } catch (error) {
    return { passed: false, message: error instanceof Error ? error.message : String(error) };
  }
  const shouldExist = check.exists !== false && check.absent !== true;
  if (!shouldExist) return { passed: info === null, message: info === null ? `${relative} is absent.` : `${relative} unexpectedly exists.` };
  if (!info?.isFile()) return { passed: false, message: `${relative} is not a file.` };
  const content = await readFile(target, "utf8");
  const failures = fileContentFailures(check, content);
  return { passed: failures.length === 0, message: failures.length === 0 ? `${relative} matched.` : `${relative}: ${failures.join("; ")}` };
}

function answerCheck(check, answer) {
  const failures = [];
  if (typeof check.equals === "string" && answer.trim() !== check.equals.trim()) failures.push("answer did not match exactly");
  for (const expected of stringList(check.contains)) {
    if (!answer.includes(expected)) failures.push(`answer missed ${JSON.stringify(expected)}`);
  }
  if (typeof check.matches === "string" && !new RegExp(check.matches, check.flags ?? "u").test(answer)) failures.push("answer did not match regex");
  if (typeof check.notMatches === "string" && new RegExp(check.notMatches, check.flags ?? "u").test(answer)) failures.push("answer matched forbidden regex");
  failures.push(...answerPatternFailures(check, answer));
  return { passed: failures.length === 0, message: failures.length === 0 ? "Final answer matched." : failures.join("; ") };
}

function answerPatternFailures(check, answer) {
  if (typeof check.pattern !== "string") return [];
  const flags = check.flags ?? "iu";
  const expression = new RegExp(check.pattern, flags.includes("g") ? flags : `${flags}g`);
  const matches = [...answer.matchAll(expression)].length;
  const minimum = Number.isInteger(check.minMatches) ? check.minMatches : 1;
  const maximum = Number.isInteger(check.maxMatches) ? check.maxMatches : Number.POSITIVE_INFINITY;
  return matches < minimum || matches > maximum
    ? [`answer regex matched ${matches} times; expected ${minimum}..${maximum}`] : [];
}

function eventCountCheck(check, events) {
  const count = events.filter((event) => {
    if (event.type !== check.eventType) return false;
    if (!check.toolName) return true;
    return event.payload?.name === check.toolName || event.payload?.toolName === check.toolName;
  }).length;
  const minimum = Number.isInteger(check.minCount) ? check.minCount : 1;
  const maximum = Number.isInteger(check.maxCount) ? check.maxCount : Number.POSITIVE_INFINITY;
  return {
    passed: count >= minimum && count <= maximum,
    message: `Event count was ${count}; expected ${minimum}..${maximum === Number.POSITIVE_INFINITY ? "Infinity" : maximum}.`,
    count
  };
}

async function commandCheck(check, context, broker) {
  const rawArgv = check.argv ?? check.command;
  if (!Array.isArray(rawArgv) || rawArgv.length === 0 || rawArgv.some((item) => typeof item !== "string")) {
    throw new Error("Command verifier requires a non-empty argv string array.");
  }
  const variables = { WORKSPACE: context.workspace, MANIFEST_DIR: context.manifestDir };
  const [command, ...args] = rawArgv.map((item) => substitute(item, variables));
  if (command !== "node") throw new Error(`Unsupported verifier executable '${command}'; EvalScenarioV1 command checks are restricted to node.`);
  // Required Windows AppContainer execution intentionally cannot lstat an
  // entire drive root. Prevent Node's ESM resolver from canonicalizing every
  // ancestor while the broker still enforces the declared read roots.
  const verifierArgs = [...args];
  const testIndex = verifierArgs.indexOf("--test");
  if (testIndex >= 0 && !verifierArgs.some((argument) => argument.startsWith("--test-isolation"))) {
    verifierArgs.splice(testIndex + 1, 0, "--test-isolation=none");
  }
  const sandboxArgs = ["--preserve-symlinks", "--preserve-symlinks-main", ...verifierArgs];
  const result = await execute(broker, context.nodePath, sandboxArgs, {
    cwd: check.cwd ? substitute(check.cwd, variables) : context.workspace,
    timeoutMs: check.timeoutMs,
    workspace: context.workspace,
    manifestDir: context.manifestDir,
    home: context.verifierHome
  });
  const expected = Number.isInteger(check.expectedExitCode) ? check.expectedExitCode
    : Number.isInteger(check.exitCode) ? check.exitCode : 0;
  return {
    passed: result.exitCode === expected,
    message: result.exitCode === expected ? `Command exited ${expected}.` : `Command exited ${result.exitCode}; expected ${expected}.`,
    ...result,
    command: [context.nodePath, ...sandboxArgs]
  };
}

function gitDiffCheck(check, delta, context) {
  const changed = [...delta.added, ...delta.modified, ...delta.deleted];
  const failures = [];
  if ((check.clean === true || check.requireClean === true) && changed.length > 0) failures.push(`workspace changed: ${changed.join(", ")}`);
  if (check.required === true && changed.length === 0) failures.push("workspace did not change");
  failures.push(...gitAllowedFailures(check, delta));
  failures.push(...gitPreservationFailures(check, context));
  return { passed: failures.length === 0, message: failures.length === 0 ? "Workspace delta matched." : failures.join("; ") };
}

function gitAllowedFailures(check, delta) {
  const allowed = check.allowedPaths ?? check.allowed ?? check.allowedChanges;
  if (!Array.isArray(allowed)) return [];
  const unauthorized = unauthorizedChanges(delta, allowed);
  return unauthorized.length > 0 ? [`unauthorized changes: ${unauthorized.join(", ")}`] : [];
}

function gitPreservationFailures(check, context) {
  if (check.preserveInitial !== true) return [];
  const initialLines = String(context.initialGit?.status ?? "").split(/\r?\n/u).filter(Boolean);
  const finalLines = new Set(String(context.finalGit?.status ?? "").split(/\r?\n/u).filter(Boolean));
  const missing = initialLines.filter((line) => !finalLines.has(line));
  return missing.length > 0 ? [`pre-existing worktree state changed: ${missing.join(", ")}`] : [];
}

function terminalStatus(subjectResult, metrics) {
  if (subjectResult.cancellation) return "cancelled";
  const outcome = subjectResult.result?.finishReason ?? subjectResult.result?.status ?? metrics?.terminal?.type;
  if (outcome === "completed" || outcome === "run.completed") return "completed";
  if (outcome === "needs_input" || outcome === "run.suspended") return "needs_input";
  if (outcome === "cancelled" || outcome === "run.cancelled") return "cancelled";
  return "error";
}

export function finalAnswerFrom(subjectResult, events) {
  const direct = subjectResult.result?.finalMessage ?? subjectResult.result?.message;
  if (typeof direct === "string" && direct.trim()) return direct;
  const visible = events.filter((event) => event.type === "model.completed")
    .map((event) => event.payload?.text ?? event.payload?.message?.content)
    .filter((value) => typeof value === "string" && value.trim());
  return visible.at(-1) ?? "";
}

async function executeVerifierCheck(check, context, answer, broker) {
  if (check.type === "file") return await fileCheck(check, context.workspace);
  if (check.type === "answer") return answerCheck(check, answer);
  if (check.type === "event_count") return eventCountCheck(check, context.events);
  if (check.type === "command") return await commandCheck(check, context, broker);
  if (check.type === "git_diff") return gitDiffCheck(check, context.delta, context);
  throw new Error(`Unknown verifier check type '${String(check.type)}'.`);
}

export async function runPostVerifier(context) {
  const {
    scenario, workspace, manifestDir, delta, subjectResult, events, metrics, artifactDir, redactor
  } = context;
  const answer = finalAnswerFrom(subjectResult, events);
  const checks = [];
  let brokerPromise;
  try {
    for (const [index, check] of (scenario.verifier?.checks ?? []).entries()) {
      let result;
      try {
        if (check.type === "command") {
          brokerPromise ??= connectVerifierBroker(context);
        }
        result = await executeVerifierCheck(
          check, { ...context, workspace, manifestDir, delta, events }, answer, await brokerPromise
        );
      } catch (error) {
        result = {
          passed: false,
          infrastructureError: true,
          message: error instanceof Error ? error.message : String(error)
        };
      }
      checks.push({ index, type: check.type, ...result });
    }
  } finally {
    const broker = await brokerPromise?.catch(() => null);
    await broker?.close();
  }
  const expectedTerminal = scenario.expectedTerminal ?? "completed";
  const actualTerminal = terminalStatus(subjectResult, metrics);
  const terminalCheck = {
    index: checks.length,
    type: "terminal",
    passed: actualTerminal === expectedTerminal,
    message: `Terminal status was ${actualTerminal}; expected ${expectedTerminal}.`
  };
  checks.push(terminalCheck);
  const log = checks.map((check) => [
    `${check.infrastructureError ? "INVALID" : check.passed ? "PASS" : "FAIL"} ${check.type}: ${check.message}`,
    check.command ? `command: ${check.command.join(" ")}` : "",
    check.stdout ? `stdout:\n${check.stdout}` : "",
    check.stderr ? `stderr:\n${check.stderr}` : ""
  ].filter(Boolean).join("\n")).join("\n\n");
  await writeFile(path.join(artifactDir, "verifier.log"), redactor(log), "utf8");
  const productChecks = checks.filter((check) => check.type !== "terminal");
  const invalid = productChecks.some((check) => check.infrastructureError);
  return {
    validity: invalid ? "invalid" : "valid",
    status: invalid ? "not_observed" : productChecks.every((check) => check.passed) ? "pass" : "fail",
    checks: checks.map(({ stdout, stderr, ...check }) => ({
      ...check,
      ...(stdout ? { stdout: redactor(stdout) } : {}),
      ...(stderr ? { stderr: redactor(stderr) } : {})
    })),
    finalAnswer: redactor(answer),
    terminal: { expected: expectedTerminal, actual: actualTerminal },
    delivery: { status: terminalCheck.passed ? "pass" : "fail", check: terminalCheck }
  };
}
