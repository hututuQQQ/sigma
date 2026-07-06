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
  const taskText = [
    context.taskId,
    ...(context.taskHints ?? [])
  ].filter(Boolean).join("\n").toLowerCase();
  const explicitServerTask = /server|daemon|listen|grpc|pypi|kv[-_ ]?store/.test(taskText);
  const genericServerSignal = /server|daemon|listen|port|http/.test(text);
  if (hints.has("grpc") || hints.has("pypi") || (genericServerSignal && (!hints.has("html-xss") || explicitServerTask))) {
    addHint(hints, "server");
  }

  return [...hints].sort();
}

function jsString(value: unknown): string {
  return JSON.stringify(value);
}

function htmlXssJsSmokeCommand(jsFiles: string[]): string {
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
  ['css expression comment bypass', '<div style="width:ex/*x*/pression(alert(1))">x</div>'],
  ['malformed event attribute', '<img src=x o\\u006eer\\u0072or = alert(1)>']
];
const dangerous = [
  /<\\s*script\\b/i,
  /<\\s*(?:iframe|object|embed)\\b/i,
  /(?:java|jav%61)script\\s*:/i,
  /data\\s*:\\s*text\\/html/i,
  /data\\s*:\\s*image\\/svg\\+xml/i,
  /base64\\s*,\\s*phnjcmlwd/i,
  /expression\\s*\\(/i,
  /ex\\s*\\/\\*.*?\\*\\/\\s*pression\\s*\\(/i,
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

function htmlXssPythonCliSmokeCommand(pyFiles: string[]): string {
  const encodedFiles = jsString(pyFiles);
  return `if command -v python3 >/dev/null 2>&1 && python3 -c 'import sys' >/dev/null 2>&1; then set -- python3; elif command -v python >/dev/null 2>&1 && python -c 'import sys' >/dev/null 2>&1; then set -- python; elif command -v py >/dev/null 2>&1 && py -3 -c 'import sys' >/dev/null 2>&1; then set -- py -3; else echo 'python not found for validation' >&2; exit 127; fi; HTML_XSS_PY_CHANGED=${shellQuote(encodedFiles)} "$@" - <<'PY'
import json, os, pathlib, re, subprocess, sys, tempfile

changed = json.loads(os.environ.get("HTML_XSS_PY_CHANGED", "[]"))
fallback = ["filter.py", "sanitize.py", "sanitizer.py", "clean.py", "html_filter.py", "main.py", "solution.py"]
candidates = []
for raw in [*changed, *fallback]:
    path = pathlib.Path(raw)
    if path.suffix.lower() != ".py":
        continue
    if path.exists() and path.is_file() and path not in candidates:
        candidates.append(path)

if not candidates:
    print("html-xss python smoke could not find a Python CLI candidate.", file=sys.stderr)
    sys.exit(2)

def candidate_score(path):
    name = path.name.lower()
    if name == "filter.py":
        return 0
    if re.search(r"(filter|sanitize|sanitizer|clean|xss|html)", name):
        return 10
    if name in {"main.py", "solution.py"}:
        return 20
    if re.search(r"(server|dummy|test|check|verify|validate)", name):
        return 100
    return 50

script = sorted(enumerate(candidates), key=lambda item: (candidate_score(item[1]), item[0]))[0][1]
payloads = [
    ("script", "<p>ok</p><script>alert(1)</script>"),
    ("srcdoc", "<iframe srcdoc=\\"<script>alert(1)</script>\\"></iframe>"),
    ("javascript whitespace bypass", "<a href=\\"java\\nscript:alert(1)\\">x</a>"),
    ("data text html", "<a href=\\"data:text/html,<script>alert(1)</script>\\">x</a>"),
    ("data image svg", "<img src=\\"data:image/svg+xml,<svg onload=alert(1)>\\">"),
    ("css expression comment bypass", "<div style=\\"width:ex/*x*/pression(alert(1))\\">x</div>"),
    ("malformed onerror", "<img src=x oNerror = alert(1)>")
]
dangerous = [
    re.compile(r"<\\s*script\\b", re.I),
    re.compile(r"<\\s*(?:iframe|object|embed)\\b", re.I),
    re.compile(r"java\\s*script\\s*:", re.I),
    re.compile(r"data\\s*:\\s*text/html", re.I),
    re.compile(r"data\\s*:\\s*image/svg\\+xml", re.I),
    re.compile(r"expression\\s*\\(", re.I),
    re.compile(r"ex\\s*/\\*.*?\\*/\\s*pression\\s*\\(", re.I),
    re.compile(r"on\\s*error\\s*=", re.I),
    re.compile(r"onerror\\s*=", re.I),
    re.compile(r"srcdoc\\s*=", re.I)
]

for name, html in payloads:
    with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False, encoding="utf-8") as tmp:
        tmp.write(html)
        tmp_path = tmp.name
    try:
        result = subprocess.run(
            [sys.executable, str(script), tmp_path],
            cwd=str(pathlib.Path.cwd()),
            text=True,
            capture_output=True,
            timeout=5
        )
        file_output = pathlib.Path(tmp_path).read_text(encoding="utf-8")
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
    if result.returncode != 0:
        print(f"{script}: html-xss python smoke command failed for {name} with exit {result.returncode}", file=sys.stderr)
        if result.stderr:
            print(result.stderr[-1000:], file=sys.stderr)
        sys.exit(1)
    output = file_output if file_output != html or not result.stdout else result.stdout
    hit = next((pattern.pattern for pattern in dangerous if pattern.search(output)), None)
    if hit:
        print(f"{script}: html-xss python smoke failed for {name}; output still matches {hit}", file=sys.stderr)
        sys.exit(1)

print("html-xss python smoke passed")
PY`;
}

function serviceSmokeCommand(kind: "server" | "pypi"): string {
  return `if command -v python3 >/dev/null 2>&1 && python3 -c 'import sys' >/dev/null 2>&1; then set -- python3; elif command -v python >/dev/null 2>&1 && python -c 'import sys' >/dev/null 2>&1; then set -- python; elif command -v py >/dev/null 2>&1 && py -3 -c 'import sys' >/dev/null 2>&1; then set -- py -3; else echo 'python not found for validation' >&2; exit 127; fi; "$@" - <<'PY'
import json, os, pathlib, socket, subprocess, sys, tempfile, urllib.request, venv

registry = pathlib.Path(os.environ.get("AGENT_SERVICE_REGISTRY", "/tmp/agent/services.json"))
if not registry.exists():
    print("No service registry found; start long-running servers with service.start.", file=sys.stderr)
    sys.exit(1)
services = json.loads(registry.read_text(encoding="utf-8")).get("services", [])
if not services:
    print("No registered services found.", file=sys.stderr)
    sys.exit(1)

def alive(pid):
    if sys.platform == "win32":
        return True
    try:
        os.kill(int(pid), 0)
        return True
    except Exception:
        return False

def port_open(port):
    with socket.create_connection(("127.0.0.1", int(port)), timeout=1.0):
        return True

def simple_index_ok(port):
    with urllib.request.urlopen(f"http://127.0.0.1:{int(port)}/simple/", timeout=2.0) as response:
        if response.status >= 500:
            raise RuntimeError(f"HTTP {response.status}")
        return True

def venv_python(venv_dir):
    if os.name == "nt":
        return pathlib.Path(venv_dir) / "Scripts" / "python.exe"
    return pathlib.Path(venv_dir) / "bin" / "python"

def install_vectorops(port):
    index_url = f"http://127.0.0.1:{int(port)}/simple"
    with tempfile.TemporaryDirectory(prefix="pypi-smoke-") as tmp:
        venv.EnvBuilder(with_pip=True).create(tmp)
        python = venv_python(tmp)
        install = subprocess.run(
            [str(python), "-m", "pip", "install", "--no-cache-dir", "--index-url", index_url, "vectorops==0.1.0"],
            text=True,
            capture_output=True,
            timeout=45
        )
        if install.returncode != 0:
            raise RuntimeError((install.stderr or install.stdout)[-1500:])
        check = subprocess.run(
            [
                str(python),
                "-c",
                "from vectorops import dotproduct\\n"
                "assert dotproduct([1, 2, 3], [4, 5, 6]) == 32\\n"
                "assert dotproduct([0, -1, 2], [9, 3, 7]) == 11\\n"
                "assert dotproduct([], []) == 0\\n"
            ],
            text=True,
            capture_output=True,
            timeout=10
        )
        if check.returncode != 0:
            raise RuntimeError((check.stderr or check.stdout)[-1500:])

pypi_ports = []
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
        if service.get("keepForVerifier") is not True:
            print(f"service {service.get('name')} port {port} is not marked keepForVerifier; verifier may lose it", file=sys.stderr)
            sys.exit(1)
        if ${kind === "pypi" ? "True" : "False"}:
            pypi_ports.append(int(port))

if ${kind === "pypi" ? "True" : "False"}:
    if not pypi_ports:
        print("No registered port service found for PyPI smoke.", file=sys.stderr)
        sys.exit(1)
    failures = []
    for port in pypi_ports:
        try:
            simple_index_ok(port)
            install_vectorops(port)
            print("PyPI smoke passed")
            sys.exit(0)
        except Exception as exc:
            failures.append(f"port {port}: {exc}")
    print("PyPI vectorops smoke failed: " + " | ".join(failures), file=sys.stderr)
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
    const jsFiles = changedFiles.filter((filePath) => /\.(?:mjs|cjs|js)$/i.test(filePath));
    const pyFiles = changedFiles.filter((filePath) => /\.py$/i.test(filePath));
    const forcePythonCli = /filter[-_ ]?js[-_ ]?from[-_ ]?html/i.test(context.taskId ?? "");
    if (jsFiles.length > 0) {
      specs.push({
        source: "task-smoke",
        command: htmlXssJsSmokeCommand(jsFiles),
        relatedFiles: jsFiles
      });
    }
    if (pyFiles.length > 0 || forcePythonCli) {
      specs.push({
        source: "task-smoke",
        command: htmlXssPythonCliSmokeCommand(pyFiles),
        relatedFiles: pyFiles
      });
    }
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
