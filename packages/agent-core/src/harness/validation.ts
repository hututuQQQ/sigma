import path from "node:path";
import type { HarnessCommandResult, SummaryJson } from "../types.js";
import { runBashCommand } from "../command-runner.js";

export interface ValidationCommandSpec {
  source: string;
  command: string;
  relatedFiles: string[];
}

export interface TaskValidationContext {
  taskId?: string;
  taskHints?: string[];
  instruction?: string;
}

function tailText(text: string, limit = 4000): string {
  return text.length <= limit ? text : text.slice(-limit);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function validationCommandsFromValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((command): command is string => typeof command === "string" && command.trim().length > 0);
}

export function summaryValidationCommands(summary: SummaryJson | Record<string, unknown> | undefined): ValidationCommandSpec[] {
  if (!summary || typeof summary !== "object") return [];
  const commands = [
    ...validationCommandsFromValue((summary as { validation_commands?: unknown }).validation_commands),
    ...validationCommandsFromValue((summary as { validationCommands?: unknown }).validationCommands)
  ];
  const harness = (summary as { harness?: unknown }).harness;
  if (harness && typeof harness === "object") {
    commands.push(
      ...validationCommandsFromValue((harness as { validation_commands?: unknown }).validation_commands),
      ...validationCommandsFromValue((harness as { validationCommands?: unknown }).validationCommands)
    );
  }
  return [...new Set(commands)].map((command) => ({ source: "summary", command, relatedFiles: [] }));
}

function scriptRunCommand(filePath: string): string | null {
  const base = path.posix.basename(filePath);
  if (!/^(check|verify|validate|test)(?:[_\-.].*|$)/.test(base)) return null;
  const quoted = shellQuote(filePath);
  if (filePath.endsWith(".py")) return `python ${quoted}`;
  if (filePath.endsWith(".sh")) return `bash ${quoted}`;
  if (filePath.endsWith(".js")) {
    return `if command -v node >/dev/null 2>&1; then node ${quoted}; else echo 'node not found for validation' >&2; exit 127; fi`;
  }
  return null;
}

export function genericValidationCommandSpecs(changedFiles: string[]): ValidationCommandSpec[] {
  const specs: ValidationCommandSpec[] = [];
  for (const filePath of changedFiles) {
    const quoted = shellQuote(filePath);
    if (filePath.endsWith(".py")) {
      specs.push({ source: "changed-file", command: `python -m py_compile ${quoted}`, relatedFiles: [filePath] });
    } else if (filePath.endsWith(".sh")) {
      specs.push({ source: "changed-file", command: `bash -n ${quoted}`, relatedFiles: [filePath] });
    } else if (filePath.endsWith(".js")) {
      specs.push({
        source: "changed-file",
        command: `if command -v node >/dev/null 2>&1; then node --check ${quoted}; else echo 'node not found for validation' >&2; exit 127; fi`,
        relatedFiles: [filePath]
      });
    }

    const scriptCommand = scriptRunCommand(filePath);
    if (scriptCommand) {
      specs.push({ source: "changed-script", command: scriptCommand, relatedFiles: [filePath] });
    }
  }
  return specs;
}

function addHint(hints: Set<string>, hint: string): void {
  hints.add(hint);
  const parts = hint.split("/").filter(Boolean);
  if (parts.length > 1) {
    hints.add(parts[0]);
    hints.add(parts[parts.length - 1]);
  }
}

export function inferTaskHints(context: TaskValidationContext = {}, changedFiles: string[] = []): string[] {
  const hints = new Set<string>();
  for (const hint of context.taskHints ?? []) {
    if (typeof hint === "string" && hint.trim()) addHint(hints, hint.trim().toLowerCase());
  }

  const text = [
    context.taskId,
    context.instruction,
    ...changedFiles
  ].filter(Boolean).join("\n").toLowerCase();

  if (/filter[-_ ]?js[-_ ]?from[-_ ]?html|html[-_ ]?xss|sanitize.*html|xss/.test(text)) {
    addHint(hints, "html-xss");
  }
  if (/grpc|protobuf|proto\b|kv[-_ ]?store/.test(text)) {
    addHint(hints, "server/grpc");
  }
  if (/pypi|python package index|simple repository|simple[-_ ]?index/.test(text)) {
    addHint(hints, "server/pypi");
  }
  if (/server|daemon|listen|port|http/.test(text) || hints.has("grpc") || hints.has("pypi")) {
    addHint(hints, "server");
  }

  return [...hints].sort();
}

function jsString(value: unknown): string {
  return JSON.stringify(value);
}

function htmlXssSmokeCommand(changedFiles: string[]): string {
  const jsFiles = changedFiles.filter((filePath) => /\.(?:mjs|cjs|js)$/i.test(filePath));
  const encodedFiles = jsString(jsFiles);
  return `HTML_XSS_CHANGED=${shellQuote(encodedFiles)} node --input-type=module - <<'NODE'
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const files = JSON.parse(process.env.HTML_XSS_CHANGED || '[]');
const payloads = [
  ['percent-encoded javascript scheme', '<a href="jav%61script:alert(1)">x</a>'],
  ['data html url', '<a href="data:text/html,<script>alert(1)</script>">x</a>'],
  ['base64 html url', '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>'],
  ['svg data url', '<img src="data:image/svg+xml,<svg onload=alert(1)>">'],
  ['iframe object embed', '<iframe srcdoc="<script>alert(1)</script>"></iframe><object data="javascript:alert(1)"></object><embed src="javascript:alert(1)">'],
  ['malformed event attribute', '<img src=x o\\u006eer\\u0072or = alert(1)>']
];
const dangerous = [
  /<\\s*script\\b/i,
  /<\\s*(?:iframe|object|embed)\\b/i,
  /(?:java|jav%61)script\\s*:/i,
  /data\\s*:\\s*text\\/html/i,
  /data\\s*:\\s*image\\/svg\\+xml/i,
  /base64\\s*,\\s*phnjcmlwd/i,
  /on\\s*error\\s*=/i,
  /onerror\\s*=/i,
  /srcdoc\\s*=/i
];
const names = ['default', 'sanitizeHtml', 'sanitize_html', 'filterHtml', 'filter_html', 'filterJsFromHtml', 'filter_js_from_html', 'removeScripts', 'cleanHtml', 'sanitize', 'filter'];

function candidatesFromModule(mod) {
  const values = [];
  for (const name of names) values.push(mod?.[name]);
  if (mod?.default && typeof mod.default === 'object') {
    for (const name of names) values.push(mod.default?.[name]);
  }
  values.push(mod?.default);
  return values.filter((value, index, all) => typeof value === 'function' && all.indexOf(value) === index);
}

let sawCandidate = false;
for (const file of files) {
  const mod = await import(pathToFileURL(path.resolve(file)).href + '?smoke=' + Date.now());
  for (const fn of candidatesFromModule(mod)) {
    sawCandidate = true;
    for (const [name, html] of payloads) {
      const output = await fn(html);
      if (typeof output !== 'string') {
        console.error(file + ': sanitizer returned ' + typeof output + ' for ' + name + ', expected string');
        process.exit(1);
      }
      const hit = dangerous.find((pattern) => pattern.test(output));
      if (hit) {
        console.error(file + ': html-xss smoke failed for ' + name + '; output still matches ' + hit);
        process.exit(1);
      }
    }
  }
}
if (!sawCandidate) {
  console.error('html-xss smoke could not find an exported sanitizer function in changed JS files.');
  process.exit(2);
}
NODE`;
}

function serviceSmokeCommand(kind: "server" | "pypi"): string {
  return `python - <<'PY'
import json, os, pathlib, socket, sys, urllib.request

registry = pathlib.Path(os.environ.get("AGENT_SERVICE_REGISTRY", "/tmp/agent/services.json"))
if not registry.exists():
    print("No service registry found; start long-running servers with service.start.", file=sys.stderr)
    sys.exit(1)
services = json.loads(registry.read_text(encoding="utf-8")).get("services", [])
if not services:
    print("No registered services found.", file=sys.stderr)
    sys.exit(1)

def alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except Exception:
        return False

def port_open(port):
    with socket.create_connection(("127.0.0.1", int(port)), timeout=1.0):
        return True

for service in services:
    if not alive(service.get("pid", -1)):
        print(f"service {service.get('name')} pid {service.get('pid')} is not alive", file=sys.stderr)
        sys.exit(1)
    port = service.get("port")
    if port is not None:
        try:
            port_open(port)
        except Exception as exc:
            print(f"service {service.get('name')} port {port} is not reachable: {exc}", file=sys.stderr)
            sys.exit(1)
        if ${kind === "pypi" ? "True" : "False"}:
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{int(port)}/simple/", timeout=2.0) as response:
                    if response.status >= 500:
                        raise RuntimeError(f"HTTP {response.status}")
            except Exception as exc:
                print(f"PyPI simple index smoke failed on port {port}: {exc}", file=sys.stderr)
                sys.exit(1)
print("service smoke passed")
PY`;
}

export function taskSmokeValidationCommandSpecs(
  changedFiles: string[],
  context: TaskValidationContext = {}
): ValidationCommandSpec[] {
  const hints = new Set(inferTaskHints(context, changedFiles));
  const specs: ValidationCommandSpec[] = [];
  if (hints.has("html-xss")) {
    specs.push({
      source: "task-smoke",
      command: htmlXssSmokeCommand(changedFiles),
      relatedFiles: changedFiles.filter((filePath) => /\.(?:mjs|cjs|js)$/i.test(filePath))
    });
  }
  if (hints.has("server") || hints.has("grpc")) {
    specs.push({ source: "task-smoke", command: serviceSmokeCommand("server"), relatedFiles: [] });
  }
  if (hints.has("pypi")) {
    specs.push({ source: "task-smoke", command: serviceSmokeCommand("pypi"), relatedFiles: [] });
  }
  return specs;
}

export function validationCommandSpecs(
  summary: SummaryJson,
  changedFiles: string[],
  context: TaskValidationContext = {}
): ValidationCommandSpec[] {
  const specs = [
    ...summaryValidationCommands(summary),
    ...genericValidationCommandSpecs(changedFiles),
    ...taskSmokeValidationCommandSpecs(changedFiles, context)
  ];
  const seen = new Set<string>();
  return specs.filter((spec) => {
    if (seen.has(spec.command)) return false;
    seen.add(spec.command);
    return true;
  });
}

export async function runHarnessCommand(options: {
  kind: "validation" | "precheck";
  source: string;
  command: string;
  workspacePath: string;
  attempt: number;
  timeoutSec: number;
  relatedFiles?: string[];
}): Promise<HarnessCommandResult> {
  const startedAt = Date.now();
  const result = await runBashCommand({
    command: options.command,
    cwd: options.workspacePath,
    env: process.env,
    timeoutMs: Math.max(1, Math.floor(options.timeoutSec * 1000))
  });

  if (result.error) {
    return {
      kind: options.kind,
      source: options.source,
      command: options.command,
      attempt: options.attempt,
      exit_code: 127,
      stdout_tail: tailText(result.stdout.toString("utf8")),
      stderr_tail: result.error.message,
      related_files: options.relatedFiles ?? [],
      timeout_sec: options.timeoutSec,
      duration_ms: Date.now() - startedAt,
      settled_on: result.settledOn,
      signal: result.signal ?? undefined,
      timed_out: result.timedOut || undefined,
      message: `${options.kind} command failed: ${result.error.message}`
    };
  }

  const code = result.timedOut ? 124 : result.exitCode ?? 1;
  const stdoutTail = tailText(result.stdout.toString("utf8"));
  const stderrTail = tailText(result.stderr.toString("utf8"));
  const label = options.kind === "validation" ? "validation" : "precheck";
  return {
    kind: options.kind,
    source: options.source,
    command: options.command,
    attempt: options.attempt,
    exit_code: code,
    stdout_tail: stdoutTail,
    stderr_tail: stderrTail,
    related_files: options.relatedFiles ?? [],
    timeout_sec: options.timeoutSec,
    duration_ms: result.durationMs,
    settled_on: result.settledOn,
    signal: result.signal ?? undefined,
    timed_out: result.timedOut || undefined,
    message: code === 0 ? `${label} command passed` : `${label} command failed with exit code ${code}`
  };
}
