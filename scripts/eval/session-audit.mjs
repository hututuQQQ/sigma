#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listV4Sessions, readV4Session, resolveWorkspaceStateRoot } from "./event-store.mjs";
import { reduceAgentEvents, renderSessionMetricsMarkdown } from "./metrics.mjs";

function positiveInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

export function parseSessionAuditArgs(argv) {
  const options = { workspace: ".", latest: 2, sessionIds: [], stdout: "markdown" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[++index];
      if (!value) throw new Error(`Missing value after ${argument}.`);
      return value;
    };
    if (argument === "--workspace") options.workspace = next();
    else if (argument === "--state-root") options.stateRoot = next();
    else if (argument === "--latest") options.latest = positiveInteger(next(), "--latest");
    else if (argument === "--session") options.sessionIds.push(next());
    else if (argument === "--sessions") options.sessionIds.push(...next().split(",").filter(Boolean));
    else if (argument === "--output") options.output = next();
    else if (argument === "--stdout") {
      options.stdout = next();
      if (!["json", "markdown", "none"].includes(options.stdout)) throw new Error("--stdout must be json, markdown, or none.");
    } else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function reportSummary(sessions) {
  return {
    sessionCount: sessions.length,
    completed: sessions.filter((item) => item.terminal.status === "completed").length,
    failed: sessions.filter((item) => item.terminal.status === "failed").length,
    incomplete: sessions.filter((item) => item.terminal.status === "incomplete").length,
    durationMs: sessions.reduce((sum, item) => sum + item.durationMs, 0),
    modelTurns: sessions.reduce((sum, item) => sum + item.counts.modelTurns, 0),
    toolCalls: sessions.reduce((sum, item) => sum + item.counts.toolCalls, 0),
    toolFailures: sessions.reduce((sum, item) => sum + item.counts.toolFailures, 0),
    approvals: sessions.reduce((sum, item) => sum + item.counts.approvals, 0),
    contextCompactions: sessions.reduce((sum, item) => sum + item.counts.contextCompactions, 0),
    inputTokens: sessions.reduce((sum, item) => sum + item.usageTotals.inputTokens, 0),
    outputTokens: sessions.reduce((sum, item) => sum + item.usageTotals.outputTokens, 0),
    costMicroUsd: sessions.reduce((sum, item) => sum + item.usageTotals.costMicroUsd, 0),
    repeatedExactRequests: sessions.reduce((sum, item) => sum + item.repeatedExactRequests.repeated, 0),
    repeatedOutputBytes: sessions.reduce((sum, item) => sum + item.repeatedOutputs.repeatedBytes, 0),
    hardFailures: sessions.reduce((sum, item) => sum + item.hardFailures.length, 0)
  };
}

export async function auditSessions(options = {}) {
  const workspace = path.resolve(options.workspace ?? ".");
  const stateRoot = path.resolve(options.stateRoot ?? await resolveWorkspaceStateRoot(workspace, options.stateOptions));
  const available = await listV4Sessions(stateRoot);
  const requested = options.sessionIds?.length > 0
    ? [...new Set(options.sessionIds)]
    : available.slice(0, options.latest ?? 2).map((item) => item.sessionId);
  const sessions = [];
  for (const sessionId of requested) {
    const stored = await readV4Session(stateRoot, sessionId);
    sessions.push(reduceAgentEvents(stored.events, { sessionId }));
  }
  return {
    schemaVersion: 1,
    kind: "sigma.agent-session-audit",
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    workspace,
    stateRoot,
    selection: {
      latest: options.sessionIds?.length > 0 ? null : options.latest ?? 2,
      sessionIds: requested
    },
    summary: reportSummary(sessions),
    sessions
  };
}

export function renderSessionAuditMarkdown(report) {
  const summary = report.summary;
  const lines = [
    "# Sigma Agent Session Audit", "",
    `Generated: ${report.generatedAt}`, "",
    "| Sessions | Completed | Failed | Duration | Model turns | Tool calls | Tool failures | Compactions | Input tokens |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    `| ${summary.sessionCount} | ${summary.completed} | ${summary.failed} | ${(summary.durationMs / 60_000).toFixed(1)} min | ${summary.modelTurns} | ${summary.toolCalls} | ${summary.toolFailures} | ${summary.contextCompactions} | ${summary.inputTokens} |`,
    ""
  ];
  for (const session of report.sessions) lines.push(renderSessionMetricsMarkdown(session).trimEnd(), "");
  return `${lines.join("\n").trimEnd()}\n`;
}

function safeTimestamp(value) {
  return value.replaceAll(":", "").replaceAll("-", "").replace(/\.\d{3}Z$/u, "Z");
}

export async function writeSessionAudit(report, outputDirectory) {
  const directory = path.resolve(outputDirectory);
  await mkdir(directory, { recursive: true });
  const jsonPath = path.join(directory, "session-audit.json");
  const markdownPath = path.join(directory, "report.md");
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderSessionAuditMarkdown(report), "utf8");
  return { directory, jsonPath, markdownPath };
}

function help() {
  return [
    "Usage: node scripts/eval/session-audit.mjs [options]",
    "  --workspace <path>       Workspace whose V4 state should be audited (default: .)",
    "  --state-root <path>      Explicit workspace state root (primarily for isolated runs)",
    "  --latest <n>             Audit the latest N sessions (default: 2)",
    "  --session <id>           Audit an exact session; repeatable",
    "  --sessions <id,id>       Audit comma-separated exact sessions",
    "  --output <directory>     Output directory under which both reports are written",
    "  --stdout <format>        markdown, json, or none (default: markdown)"
  ].join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseSessionAuditArgs(argv);
  if (options.help) {
    process.stdout.write(`${help()}\n`);
    return null;
  }
  const report = await auditSessions(options);
  const output = options.output ?? path.join(
    path.resolve(options.workspace), ".artifacts", "eval", `session-audit-${safeTimestamp(report.generatedAt)}`
  );
  const written = await writeSessionAudit(report, output);
  if (options.stdout === "json") process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else if (options.stdout === "markdown") process.stdout.write(renderSessionAuditMarkdown(report));
  process.stderr.write(`Session audit JSON: ${written.jsonPath}\nSession audit Markdown: ${written.markdownPath}\n`);
  return { report, written };
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
