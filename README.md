<p align="center">
  <img src="assets/sigma-code-mark.png" alt="Sigma Code logo" width="140" />
</p>

# Sigma Agent Runtime

A small coding-agent monorepo inspired by Pi with four layers:

- `packages/agent-ai`: provider-agnostic model interface for DeepSeek and GLM/Zhipu
- `packages/agent-core`: agent run controller, validation and retry controller, extensible tool registry, repo-aware context, durable sessions, checkpoints, JSONL tracing, MCP bridge, and workspace tools
- `packages/agent-cli`: plain terminal CLI with `run`, `solve` compatibility alias, `sessions`, `session`, checkpoint commands, `chat`, `doctor`, and `replay`
- `packages/agent-tui`: interactive terminal product entry that drives the shared `agent-core` run path

Sigma keeps the product runtime portable while adding repo instructions, deterministic repo maps, live progress, approval-gated mutating tools, and stdio/HTTP MCP tools. There is intentionally no large web UI, sub-agent system, plugin marketplace, long-term memory, or Docker sandbox in this repo.

## Install And Build

```bash
pnpm install
pnpm build
pnpm test
pnpm test:harbor
```

`pnpm test` runs the product TypeScript/Vitest suite. `pnpm test:harbor` runs only the external Harbor adapter Python tests, and `pnpm test:all` runs both.

The CLI binary is named `agent` after build:

```bash
pnpm --filter agent-cli start -- --help
```

The interactive TUI is available through the root `agent tui` command after build:

```bash
pnpm --filter agent-cli start -- tui --help
```

The `agent-tui` binary remains as a compatibility and development entrypoint.

## Local Usage

Set one provider key. Keys are never hard-coded or printed in full.

```bash
export DEEPSEEK_API_KEY=...
# or
export ZAI_API_KEY=...
```

DeepSeek example:

```bash
pnpm install
pnpm build

DEEPSEEK_API_KEY=... pnpm --filter agent-cli start -- run \
  --workspace ./examples/hello \
  --instruction "Create hello.txt containing hello world" \
  --provider deepseek \
  --model deepseek-v4-pro \
  --permission-mode yolo \
  --trace-jsonl ./trace.jsonl \
  --summary-json ./summary.json
```

Interactive TUI example:

```bash
pnpm --filter agent-cli start -- tui \
  --workspace . \
  --provider deepseek \
  --model deepseek-v4-pro \
  --permission-mode ask
```

Type a task and press Enter to start one run. The TUI opens as a transcript-first Sigma Code stream rather than a boxed dashboard:

```text
  ███████████
  ██              ∑ Sigma Code v0.1.0
    ██            DeepSeek · deepseek-v4-pro
      ██          ./agent-tui
    ██
  ██
  ███████████

* Ready in agent-tui
----------------------------------------
> fix the failing tests|
----------------------------------------
  ? for shortcuts     build - deepseek/deepseek-v4-pro - ask - idle
```

Windows PowerShell uses Unicode by default in normal terminals:

```powershell
$env:DEEPSEEK_API_KEY='sk-...'
pnpm --filter agent-tui start -- --workspace . --provider deepseek
# Unicode terminals show the pixel Sigma welcome mark.
```

If a provider key is missing, the stream shows one actionable card instead of duplicate raw error rows:

```text
✕ Missing DEEPSEEK_API_KEY
  Set it with: $env:DEEPSEEK_API_KEY='...' on PowerShell
  Or switch provider: /provider glm
  Run /status or agent doctor --check-api
```

During a run, user, assistant, token deltas, tool, validation, approval, diff, and summary entries are rendered inline in the stream. `/status`, `/tools`, `/tokens`, `/context`, `/diff stat`, and `/diff patch` open focused details only when requested; there is no permanent right-hand status wall. `/` opens a compact command palette above the composer. Aliases include `/h` or `/?` for help, `/s` status, `/d` diff, `/ds` diff stat, `/dp` diff patch, `/t` tools, `/c` context, `/tk` tokens, `/w` workspace, `/q` exit, and `/cl` clear.

Composer editing is handled in raw mode: Left/Right move the cursor, `Ctrl+A/E` jump to start/end, `Ctrl+U/K` kill to start/end, `Ctrl+W` deletes the previous word, `Ctrl+Y` yanks killed text, `Ctrl+J` inserts a newline, and Up/Down cycle in-memory prompt history. `Tab` accepts an active command/file suggestion or opens the workbench; `Shift+Tab` toggles plan/build mode. `/mode plan` and `/mode build` are also available, and the composer footer shows the active mode while a run is active. Plan mode disables mutating/run tools for new agent runs: `write`, `edit`, `apply_patch`, `bash`, `shell_session`, and `service`. Typing `@prefix` suggests workspace files; Space marks the highlighted file for multi-select, and Enter/Tab inserts the selected mentions. Typing `!command` runs a local shell command through the same approval flow as `/shell <command>`. Typing `cd <path>` switches workspace locally when the directory exists; use `/workspace <path>` or `/w <path>` for the explicit command form.

Session and transcript commands are available inside the TUI:

```text
/sessions
/session <session-id>
/resume <session-id> continue the fix
/fork <session-id> try a smaller approach
/search parser error
/history validation failed
```

`Ctrl+C` cancels the active run first. If no run is active, or if cancellation is already in progress, `Ctrl+C` exits the TUI.

Shell completion scripts are generated by the root CLI:

```bash
agent completion bash
agent completion zsh
agent completion fish
```

Programmatic product integrations should prefer the run-controller API names:

```ts
import { runConfiguredAgent, runAgentWithController, type AgentRunControllerConfig } from "agent-core";
```

The older `runAgentHarness` and `AgentHarnessConfig` exports remain available for compatibility with existing adapters and scripts.

GLM/Zhipu example:

```bash
ZAI_API_KEY=... pnpm --filter agent-cli start -- run \
  --workspace ./examples/hello \
  --instruction "Create hello.txt containing hello world" \
  --provider glm \
  --model glm-5.2 \
  --permission-mode yolo \
  --trace-jsonl ./trace.jsonl \
  --summary-json ./summary.json
```

Instruction input can come from a positional string, `--instruction`, `--instruction-file`, or stdin:

```bash
pnpm --filter agent-cli start -- run "Fix the failing tests" --workspace .

printf "Fix the failing tests" | pnpm --filter agent-cli start -- solve \
  --workspace . \
  --provider deepseek \
  --permission-mode yolo
```

Useful checks:

```bash
pnpm --filter agent-cli start -- doctor --workspace .
pnpm --filter agent-cli start -- doctor --workspace . --json
pnpm --filter agent-cli start -- doctor --workspace . --provider glm --check-api
pnpm --filter agent-cli start -- replay --trace-jsonl ./trace.jsonl
pnpm --filter agent-cli start -- replay --trace-jsonl ./trace.jsonl --timeline
```

Durable sessions are recorded by default under `.agent/sessions/` while the compatibility files `.agent/trace.jsonl`, `.agent/session.jsonl`, and `.agent/summary.json` continue to be written:

```text
.agent/sessions/index.jsonl
.agent/sessions/<session-id>/meta.json
.agent/sessions/<session-id>/events.jsonl
.agent/sessions/<session-id>/summary.json
.agent/sessions/<session-id>/checkpoints/
```

Session commands:

```bash
pnpm --filter agent-cli start -- sessions --workspace .
pnpm --filter agent-cli start -- history --workspace .
pnpm --filter agent-cli start -- session show <session-id> --workspace .
pnpm --filter agent-cli start -- session search "parser error" --workspace .
pnpm --filter agent-cli start -- session resume <session-id> "continue the fix" --workspace .
pnpm --filter agent-cli start -- session fork <session-id> "try a smaller approach" --workspace .
```

`resume` and `fork` start a fresh run with a concise prior-session context block, not a provider-specific replay of every tool message. The new session records `parentSessionId`; forked sessions also record `forkedFromSessionId`.

Mutating tools create checkpoints when they actually change files. Git workspaces use lightweight reverse patches; non-git workspaces use file-backed checkpoints for `write`, `edit`, and `apply_patch`, with best-effort manifest records for command tools such as `bash`, `shell_session`, and `service`:

```bash
pnpm --filter agent-cli start -- checkpoints <session-id> --workspace .
pnpm --filter agent-cli start -- checkpoint show <session-id> <checkpoint-id> --workspace .
pnpm --filter agent-cli start -- checkpoint restore <session-id> <checkpoint-id> --workspace .
pnpm --filter agent-cli start -- checkpoint restore <session-id> <checkpoint-id> --workspace . --force
```

Checkpoint restore is conservative. Git checkpoints first run `git apply -R --check` and only apply the reverse patch if the current workspace can accept it cleanly. File-backed checkpoints compare current file hashes with the checkpoint after-state before restoring; `--force` is required to overwrite newer user changes.

## Smoke Tests

Deterministic fake-provider smoke does not call external APIs. It verifies the CLI/core/tool pipeline against four local tasks and writes traces plus summaries under `.artifacts/smoke-local/`:

```bash
pnpm smoke:local:fake
```

Real DeepSeek local smoke:

```bash
export DEEPSEEK_API_KEY=...
AGENT_PROVIDER=deepseek AGENT_MODEL=deepseek-v4-pro pnpm smoke:local
```

Real GLM/Zhipu local smoke:

```bash
export ZAI_API_KEY=...
AGENT_PROVIDER=glm AGENT_MODEL=glm-5.2 pnpm smoke:local
```

Harbor smoke builds the CLI tarball, verifies Terminal-Bench with the oracle, then runs one custom-agent job:

```bash
export DEEPSEEK_API_KEY=...
AGENT_PROVIDER=deepseek pnpm smoke:harbor
```

The Harbor artifact is a self-contained Linux bundle. Packaging downloads the pinned Linux Node runtime into `.artifacts/cache/` when needed; offline environments can pre-fill that cache or set `NODE_RUNTIME_TARBALL`.

## External Benchmark Adapters

Harbor and Terminal-Bench support lives at the edge of the repo in `portable/harbor` and `scripts/bench-*`. Those files are external adapters and reporting tools. They may package and launch Sigma, but product core code must not depend on Harbor task identity, verifier output, benchmark names, or scoring details.

Terminal-Bench benchmark runs use Harbor, package the Sigma CLI first, and save artifacts under `.artifacts/bench/<run-id>/`. The run id is `YYYYMMDD-HHMMSS-provider-model`.

DeepSeek Pro fixed commands:

```bash
export DEEPSEEK_API_KEY=...
pnpm bench:tb:deepseek:k5
pnpm bench:tb:deepseek:k10
pnpm bench:tb:deepseek:task -- --task-id <task-id>
```

DeepSeek small batch:

```bash
export DEEPSEEK_API_KEY=...
AGENT_PROVIDER=deepseek AGENT_MODEL=deepseek-v4-pro pnpm bench:tb:k -- --k 5
```

GLM/Zhipu small batch:

```bash
export ZAI_API_KEY=...
AGENT_PROVIDER=glm AGENT_MODEL=glm-5.2 pnpm bench:tb:k -- --k 5
```

Smoke:

```bash
pnpm bench:tb:smoke
```

Single task, when the installed Harbor CLI exposes a task selection flag:

```bash
AGENT_PROVIDER=deepseek AGENT_MODEL=deepseek-v4-pro pnpm bench:tb:task -- --task-id <task-id>
```

Refresh a report:

```bash
pnpm bench:tb:report -- --run-id <run-id>
```

Refresh all reports:

```bash
pnpm bench:tb:report:all
```

Each run directory contains `config.json`, `command.sh`, `resolved-job.config.json`, `harbor.stdout.log`, `harbor.stderr.log`, `result.raw.log`, `report.json`, `report.md`, and `tasks/<task-id-or-index>/` when per-task files are available. The Harbor adapter always attempts to download `trace.jsonl`, `summary.json`, and run attempt artifacts; if Harbor does not expose task context in a predictable way, the report falls back to `harbor-jobs/**/agent/trace.jsonl` and Harbor trial `result.json`.

Failure categories are rule based and intentionally small: `host_proxy_error`, `host_encoding_error`, `harbor_cli_error`, `node_missing`, `agent_setup_failed`, `api_error`, `agent_timeout`, `max_turns`, `tool_timeout`, `verifier_failed`, `agent_crashed`, and `unknown`. Counts in `report.json` group those into `passed`, `failed`, `infra_failed`, `timeout`, `api_error`, and `unknown`.

Benchmark reports include `suggested_owner` for each task to guide follow-up fixes. Unless it points to `portable/harbor` or `scripts/bench`, do not prioritize changes to Harbor adapter plumbing.

Validation, retry, precheck, cleanup, and attempt summaries are owned by `packages/agent-core` and exposed through `agent solve` run-controller flags. The portable Harbor runtime only forwards explicit adapter kwargs to the CLI and mirrors artifacts; it must not feed verifier failures or benchmark identity back into the solving agent.

Harbor executable resolution is explicit and recorded in `config.json`: set `HARBOR_BIN` to force a specific CLI path; otherwise the runner checks common Windows uv/local install paths before falling back to `harbor` on PATH.

Terminal-Bench timeouts are resolved from Harbor task metadata before non-oracle runs. The runner probes the selected task set, then runs Harbor with a resolved JobConfig that uses the same task list. MVP defaults are intentionally lenient: `agent_wall_time_sec = max(recommended * 1.5, recommended + 600s)`, then Harbor's outer agent timeout adds `AGENT_TIMEOUT_GRACE_SEC` (default `120`). Override the internal agent wall time with `AGENT_MAX_WALL_TIME_SEC`; tune leniency with `AGENT_TIMEOUT_LENIENCY_MULTIPLIER` and `AGENT_TIMEOUT_LENIENCY_MIN_EXTRA_SEC`.

Adapter report notes:

- `bench:tb:task` writes a Harbor JobConfig and does not depend on task-selection CLI flags, but still records detected CLI capabilities for diagnostics.
- Reports include per-task verifier reward and failed test details when Harbor writes `verifier/ctrf.json` or `verifier/test-stdout.txt` under the configured jobs directory.
- Reports mark stale run directories as `incomplete` when `config.json` is still running or expected logs are missing.

## CLI Flags

`agent run` supports the non-interactive coding-agent flow. `agent solve` remains a compatibility alias with the same flags:

```text
--workspace <path>
--instruction "..."
--instruction-file <path>
--provider <deepseek|glm>
--model <model>
--max-turns <number>
--max-wall-time-sec <number>
--command-timeout-sec <number>
--permission-mode <ask|yolo>
--trace-jsonl <path>
--summary-json <path>
--session-jsonl <path>
--output-format <text|json|stream-json>
--json
--quiet
--max-tool-output-chars <number>
--max-message-history-chars <number>
--message-history-retain <number>
--compaction-summary-chars <number>
--validation-mode <off|auto>
--validation-retry-limit <number>
--validation-timeout-sec <number>
--precheck-command <command>
--precheck-timeout-sec <number>
--validation-command <command>
--validation-commands <comma-separated-commands>
--post-run-cleanup-globs <comma-separated-globs>
--harness-timeout-sec <number>      Legacy-compatible spelling for the run-controller timeout
--retry-min-budget-sec <number>
--attempts-dir <path>
--allowed-tools <comma-separated-tools>
--disabled-tools <comma-separated-tools>
--no-project-instructions
--project-doc-max-bytes <number>
--context-mode <off|repo-map>
--repo-map-max-chars <number>
--final-evidence-mode <off|auto>
--skills-mode <off|auto>
--skills-max-chars <number>
--enable-mcp
--mcp-config <path>
--stream-ui
--no-stream-ui
```

Config precedence is CLI flags, environment variables, workspace `.agent/config.toml`, home `~/.agent/config.toml`, then defaults. Top-level keys remain supported, and sectioned TOML can group related settings:

```toml
provider = "deepseek"
model = "deepseek-v4-pro"

[run]
max_turns = 30
max_wall_time_sec = 1800
permission_mode = "ask"

[validation]
mode = "auto"
retry_limit = 1
commands = ["pnpm test", "pnpm lint"]

[tools]
allowed = ["read", "write", "edit", "bash", "validate"]
disabled = []

[mcp]
enabled = true
config = ".agent/mcp.json"

[tui]
stream_ui = true
```

Local `agent run` and `agent solve` default to `--validation-mode off`. Validation commands come only from explicit CLI/config settings or the generic changed-file strategy used by `--validation-mode auto`; assistant final text is never parsed for validation commands. External adapters may pass `--validation-mode auto` plus retry, precheck, cleanup, and attempts settings when those run-controller behaviors are wanted.

`--precheck-command` runs before each agent attempt. A failing precheck records `precheck_failed` and stops before the model is called.

`--validation-mode auto` also defaults `--final-evidence-mode auto`, which gives the model one extra nudge if it tries to finish a code or executable task without successful executable verification evidence. Set `--final-evidence-mode off` to preserve the older stop behavior. When skills are enabled, selected skill names and sources are recorded in summary JSON.

Environment variables mirror the new flags. `AGENT_HARNESS_TIMEOUT_SEC` is the compatibility spelling for the run-controller timeout:

```text
AGENT_VALIDATION_MODE
AGENT_VALIDATION_COMMAND
AGENT_VALIDATION_COMMANDS
AGENT_VALIDATION_RETRY_LIMIT
AGENT_VALIDATION_TIMEOUT_SEC
AGENT_PRECHECK_COMMAND
AGENT_PRECHECK_TIMEOUT_SEC
AGENT_POST_RUN_CLEANUP_GLOBS
AGENT_HARNESS_TIMEOUT_SEC
AGENT_RETRY_MIN_BUDGET_SEC
AGENT_ALLOWED_TOOLS
AGENT_DISABLED_TOOLS
AGENT_NO_PROJECT_INSTRUCTIONS
AGENT_PROJECT_DOC_MAX_BYTES
AGENT_CONTEXT_MODE
AGENT_REPO_MAP_MAX_CHARS
AGENT_FINAL_EVIDENCE_MODE
AGENT_SKILLS_MODE
AGENT_SKILLS_MAX_CHARS
AGENT_ENABLE_MCP
AGENT_MCP_CONFIG
AGENT_OUTPUT_FORMAT
AGENT_QUIET
AGENT_STREAM_UI
AGENT_NO_STREAM_UI
```

In text mode, `agent run` prints live progress to stderr by default and keeps the final status summary on stdout. Use `--quiet` for only the final message or a minimal final summary, or `--no-stream-ui` to suppress live progress. `--output-format json` (or `--json`) writes one redacted `AgentRunResult` object to stdout. `--output-format stream-json` writes redacted JSONL event records to stdout and ends with a `{"type":"result","result":...}` record. Human stream UI is disabled by default in JSON modes unless `--stream-ui` is explicitly passed. `scripts/smoke-local.mjs` already passes `--no-stream-ui` for real CLI smoke tasks.

OpenAI-compatible providers support SSE model streaming. The core run loop prefers `stream(req)` when available, emits `assistant_delta`, `reasoning_delta`, `tool_call_delta`, and `usage` events, and falls back to `complete(req)` for clients without streaming. `AbortSignal` is threaded through model requests and command tools; cancelled runs end with `finish_reason=cancelled`, and command metadata marks `cancelled=true` when a process tree is stopped mid-tool.

## Tools And Permissions

The default tool registry is extensible and can be injected, merged, filtered, or configured with `--allowed-tools` and `--disabled-tools`. Tool names must be unique; duplicate names fail clearly unless an internal override path is used.

The core loop exposes these default tools:

- `bash`: runs `bash -lc` in the workspace, captures stdout/stderr/exit code/duration, times out safely, and truncates large output with a head/tail strategy. Commands that look mutating require approval in `ask`.
- `service`: starts, inspects, logs, and stops long-running services. Default logs are workspace-contained under `.agent/services/`.
- `read`: reads workspace files with optional offset and limit; binary files return metadata instead of raw bytes.
- `read_many`: reads multiple workspace files or snippets in one call, with the same path safety as `read`.
- `write`: writes UTF-8 files inside the workspace.
- `edit`: exact string replacement with optional `expectedReplacements`.
- `list`: lists workspace files/directories with `path`, `depth`, `includeHidden`, and `maxEntries`.
- `glob`: finds files with simple `*`, `**`, and `?` patterns.
- `grep`: searches text files, preferring `rg` when available and falling back to Node.
- `repo_query`: searches workspace files with lexical, symbol, and path signals and returns compact scored snippets for text, symbols, tests, configs, or paths. Matches include path, line range, score, reasons, and snippet.
- `symbol_search`: searches declared functions, classes, interfaces, types, constants, and test declarations using the lightweight local code index.
- `git_status`: read-only `git status`, bounded by the command timeout.
- `git_diff`: read-only `git diff` or `git diff --staged`, bounded by the command timeout.
- `apply_patch`: validates and applies safe unified diffs to workspace-relative files, including quoted paths with spaces. Its `git apply` subprocesses are bounded by the command timeout and return `metadata.timedOut` on timeout.
- `validate`: runs an explicit validation command or infers one for changed files, a file, or the project. It returns structured `ok`, `command`, `kind`, `exitCode`, output tails, related files, and best-effort diagnostics.
- `todo`: maintains run-scoped todo state for the agent.
- `shell_session`: starts, sends to, reads from, lists, and stops a persistent non-PTY bash session for multi-step terminal workflows.

Paths exposed to tools are resolved inside the workspace and rejected if they escape it. `permission-mode ask` allows read-only tools. Mutating tools require an interactive approval prompt when stdin/stdout are TTY; non-interactive `ask` denies mutating tools conservatively. `permission-mode yolo` allows mutating tools without prompting and is intended only for trusted unattended automation.

Interactive approval prompt:

```text
Tool: apply_patch
Risk: write
Summary: Apply patch to src/index.ts
Allow? [y]es / [n]o / [a]lways for this tool
```

## Project Context

Project instructions are loaded by default before the user task. Sigma checks these files with same-directory precedence:

```text
AGENTS.override.md
AGENTS.md
SIGMA.md
.agent/instructions.md
```

The current implementation loads from the workspace root and is structured for nested working directories later. Use `--no-project-instructions` to disable loading and `--project-doc-max-bytes <number>` to change the default 32768-byte limit.

Local `agent run` and `agent solve` default to `--context-mode repo-map`. The startup repo map is deterministic and budgeted; it includes a bounded file tree, package scripts, pnpm workspace patterns, TypeScript references, exported TS/JS symbols, Python and shell symbols, test file paths, `.agent/config.toml` presence, and a small git state summary. Use `--context-mode off` to disable it or `--repo-map-max-chars <number>` to change the default 20000-character budget.

Repo map generation, `repo_query`, `symbol_search`, and `read_many` share the same workspace path safety and ignore behavior. The walker honors built-in skips plus workspace `.gitignore` and `.agentignore`. `repo_query` and `symbol_search` use a lightweight code index during tool calls; mutating tools invalidate that index after detected changes so subsequent lookups see fresh files.

Generic coding skills are loaded in `--skills-mode auto` by default. Built-in skills cover common stacks such as Python/pytest, Node/TypeScript, Go/Rust/Java tests, services and ports, certificates, archives, data processing, and small-sample ML training checks. Workspace skills can be added as Markdown files under `.agent/skills/*.md`; malformed files are ignored or parsed best-effort. Selected skills are injected after project instructions and repo map context, bounded by `--skills-max-chars`.

## MCP Tools

Sigma can load tools from local stdio MCP servers and JSON-RPC HTTP MCP servers when `--enable-mcp` is set.

Default config path:

```text
.agent/mcp.json
```

Custom config:

```bash
pnpm --filter agent-cli start -- run \
  --workspace . \
  --instruction "Use the local MCP echo tool" \
  --provider deepseek \
  --enable-mcp \
  --mcp-config .agent/mcp.json
```

Example `.agent/mcp.json`:

```json
{
  "servers": {
    "local": {
      "transport": "stdio",
      "command": "node",
      "args": [".agent/servers/echo.mjs"],
      "env": { "EXAMPLE": "value" },
      "enabled": true,
      "startupTimeoutSec": 10,
      "toolTimeoutSec": 60,
      "enabledTools": ["echo"],
      "disabledTools": [],
      "approvalMode": "prompt"
    },
    "remote": {
      "transport": "http",
      "url": "http://127.0.0.1:3333/mcp",
      "headers": {
        "X-Project": "sigma"
      },
      "bearerTokenEnv": "SIGMA_MCP_TOKEN",
      "enabled": true,
      "startupTimeoutSec": 10,
      "toolTimeoutSec": 60,
      "approvalMode": "auto"
    }
  }
}
```

HTTP MCP sends JSON-RPC `initialize`, `tools/list`, `tools/call`, and best-effort `shutdown`/`close` requests to the configured URL. `headers` are copied into requests, and `bearerTokenEnv` reads a token from the environment without writing the secret into traces, summaries, or warning output.

MCP tool names are exposed as `mcp_<server>_<tool>` after sanitization, for example `mcp_local_echo`. `approvalMode` can be:

- `prompt`: ask in `permission-mode ask`.
- `approve`: allow configured tools.
- `auto`: allow only tools with MCP `annotations.readOnlyHint`; otherwise ask or deny based on permission mode.

When `--enable-mcp` is set, enabled server startup/listing failures are reported to stderr as redacted warnings such as `[sigma] mcp_error server=local error=MCP request timed out: initialize`. Core tools still load by default, and summary JSON includes each server's `mcp_servers` entry with `transport`, `tools_loaded`, and any redacted error text.

## Summary JSON

`agent run` and the compatibility `agent solve` command write:

```json
{
  "status": "completed",
  "finish_reason": "assistant_stop",
  "turns": 12,
  "tool_calls": 30,
  "commands_executed": 15,
  "input_tokens": 12345,
  "output_tokens": 2345,
  "cache_tokens": 0,
  "cost_usd": null,
  "provider": "deepseek",
  "model": "deepseek-v4-pro",
  "duration_ms": 123456,
  "last_error": null,
  "tools_available": ["bash", "read", "write"],
  "changed_files": ["src/index.ts"],
  "todo_items": [
    {
      "id": "1",
      "text": "Run validation",
      "status": "done"
    }
  ],
  "project_instruction_sources": ["AGENTS.md"],
  "context_mode": "repo-map",
  "repo_map_chars": 14200,
  "mcp_servers": [
    {
      "name": "local",
      "enabled": true,
      "transport": "stdio",
      "tools_loaded": 1
    }
  ],
  "workflow": {
    "phase": "final",
    "commands_tried": ["pnpm test"],
    "changed_files": ["src/index.ts"]
  },
  "evidence": [
    {
      "kind": "test",
      "toolName": "bash",
      "ok": true,
      "executable": true,
      "command": "pnpm test",
      "timestamp": "2026-01-01T00:00:00.000Z"
    }
  ],
  "final_gate": {
    "mode": "auto",
    "nudged": false,
    "status": "satisfied"
  },
  "selected_skills": [
    {
      "name": "node-typescript",
      "source": "built-in"
    }
  ],
  "harness": {
    "attempts": [
      {
        "attempt": 1,
        "status": "completed",
        "finish_reason": "assistant_stop",
        "summary_path": "attempts/attempt-1/summary.json",
        "trace_path": "attempts/attempt-1/trace.jsonl"
      }
    ],
    "validation_results": [],
    "precheck_results": [],
    "retry_decisions": [],
    "managed_service_finalization": null,
    "post_run_cleanup": null
  }
}
```

When the run controller performs multiple attempts, the top-level count and token fields are aggregated across attempts. Per-attempt summaries and traces are preserved under the configured `attempts` directory. The parent durable session records attempt events and controller check events with `metadata.attempt`, and `agent session show <id> --json` exposes `attemptSummaries` plus recent controller events.

The newer fields are optional. They appear when relevant and preserve existing summary keys for downstream consumers. The summary object key is still `harness` for compatibility; product code should treat it as run-controller metadata.

## Harbor And Terminal-Bench 2.0

The portable Harbor runtime is built from `packages/agent-ai`, `packages/agent-core`, and `packages/agent-cli`. `pnpm package:agent-cli` turns the CLI packages into a portable Linux tarball for task containers. `pnpm package:harbor-runtime` then creates the host-side portable Harbor runtime and JobConfigs in:

```text
.artifacts/harbor-runtime/
  sigma_harbor_agent.py
  README.md
  jobconfig.deepseek.k5.json
```

## Portable Harbor Runtime

Generate and run the portable path directly:

```bash
pnpm build
pnpm package:agent-cli
pnpm package:harbor-runtime

export DEEPSEEK_API_KEY=...
PYTHONPATH="$PWD/.artifacts/harbor-runtime" \
harbor run --config .artifacts/harbor-runtime/jobconfig.deepseek.k5.json
```

Harbor benchmark execution uses the portable runtime generated under `.artifacts/harbor-runtime` from `portable/harbor/sigma_harbor_agent.py`. Product packages do not import this adapter. Use `sigma_harbor_agent:SigmaCliHarborAgent`.

Generated JobConfigs import `sigma_harbor_agent:SigmaCliHarborAgent` and include an absolute `agent_cli_tarball` path such as `.artifacts/agent-cli-linux-x64.tgz`. They require the portable runtime directory on `PYTHONPATH`; they do not require the repo root.

The portable Python adapter depends only on the Python standard library and Harbor. It uploads the agent CLI tarball, extracts it to `/opt/agent-cli`, symlinks `/usr/local/bin/agent`, runs `/usr/local/bin/agent solve`, forwards provider env keys, downloads `/tmp/agent/summary.json`, `/tmp/agent/trace.jsonl`, and best-effort `/tmp/agent/attempts/**`, and fills Harbor context fields. Validation, retry, precheck, and cleanup behavior lives in `agent-core` and is controlled through CLI flags.

The convenience benchmark commands still work and now default to the portable runtime:

```bash
pnpm bench:tb:deepseek:k5
pnpm bench:tb:deepseek:task -- --task-id <task-id>
```

During these runs, `scripts/bench-terminal-bench.mjs` packages the agent CLI, packages the Harbor runtime, puts `.artifacts/harbor-runtime` on `PYTHONPATH`, writes a portable JobConfig, runs Harbor, and collects reports.

`pnpm package:agent-cli` bundles the pinned Linux Node runtime. By default packaging targets `x64`; set `AGENT_TARGET_ARCH=arm64` for an arm64 artifact. If `NODE_RUNTIME_TARBALL` is set, that tarball is used. Otherwise the package script uses `.artifacts/cache/node-v22.16.0-linux-<arch>.tar.xz` or downloads it from nodejs.org into that cache. The bundle writes `package-metadata.json` with the runtime URL, version, target architecture, cache path, source, and download status.

Artifact checks:

```bash
pnpm package:agent-cli
tar -tzf .artifacts/agent-cli-linux-x64.tgz | grep 'bin/agent'
tar -tzf .artifacts/agent-cli-linux-x64.tgz | grep 'bin/node'
grep -R "sigma_harbor_agent:SigmaCliHarborAgent" .artifacts/harbor-runtime/jobconfig*.json
```

The adapter forwards `DEEPSEEK_API_KEY`, `GLM_API_KEY`, `ZAI_API_KEY`, `BIGMODEL_API_KEY`, `DEEPSEEK_BASE_URL`, `GLM_BASE_URL`, and `ZAI_BASE_URL` into the task container.
