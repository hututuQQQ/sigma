# Sigma Agent MVP

A small coding-agent monorepo inspired by Pi with only three layers:

- `packages/agent-ai`: provider-agnostic model interface for DeepSeek and GLM/Zhipu
- `packages/agent-core`: autonomous loop, benchmark harness, JSONL tracing, session records, and workspace tools
- `packages/agent-cli`: plain terminal CLI with `solve`, `chat`, `doctor`, and `replay`

There is intentionally no TUI, MCP, sub-agent system, web UI, plugin marketplace, long-term memory, or complex sandboxing.

## Install And Build

```bash
pnpm install
pnpm build
pnpm test
```

The CLI binary is named `agent` after build:

```bash
pnpm --filter agent-cli start -- --help
```

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

DEEPSEEK_API_KEY=... pnpm --filter agent-cli start -- solve \
  --workspace ./examples/hello \
  --instruction "Create hello.txt containing hello world" \
  --provider deepseek \
  --model deepseek-v4-pro \
  --permission-mode yolo \
  --trace-jsonl ./trace.jsonl \
  --summary-json ./summary.json
```

GLM/Zhipu example:

```bash
ZAI_API_KEY=... pnpm --filter agent-cli start -- solve \
  --workspace ./examples/hello \
  --instruction "Create hello.txt containing hello world" \
  --provider glm \
  --model glm-5.2 \
  --permission-mode yolo \
  --trace-jsonl ./trace.jsonl \
  --summary-json ./summary.json
```

Instruction input can come from `--instruction`, `--instruction-file`, or stdin:

```bash
printf "Fix the failing tests" | pnpm --filter agent-cli start -- solve \
  --workspace . \
  --provider deepseek \
  --permission-mode yolo
```

Useful checks:

```bash
pnpm --filter agent-cli start -- doctor --workspace .
pnpm --filter agent-cli start -- doctor --workspace . --provider glm --check-api
pnpm --filter agent-cli start -- replay --trace-jsonl ./trace.jsonl
```

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

The Harbor artifact is a self-contained Linux bundle when built with a Node runtime tarball. Provide `NODE_RUNTIME_TARBALL` or place the pinned Node tarball in `.artifacts/cache/`; task containers do not need system `node` for the preferred tarball install path.

## Benchmark Runs

Terminal-Bench benchmark runs use Harbor, package the Sigma CLI first, and save artifacts under `.artifacts/bench/<run-id>/`. The run id is `YYYYMMDD-HHMMSS-provider-model`.

DeepSeek Pro fixed commands:

```bash
export DEEPSEEK_API_KEY=...
pnpm bench:tb:deepseek:k5
pnpm bench:tb:deepseek:k10
pnpm bench:tb:deepseek:task -- --task-id openssl-selfsigned-cert
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

Each run directory contains `config.json`, `command.sh`, `resolved-job.config.json`, `harbor.stdout.log`, `harbor.stderr.log`, `result.raw.log`, `report.json`, `report.md`, and `tasks/<task-id-or-index>/` when per-task files are available. The Harbor adapter always attempts to download `trace.jsonl`, `summary.json`, and harness attempt artifacts; if Harbor does not expose task context in a predictable way, the report falls back to `harbor-jobs/**/agent/trace.jsonl` and Harbor trial `result.json`.

Failure categories are rule based and intentionally small: `host_proxy_error`, `host_encoding_error`, `harbor_cli_error`, `node_missing`, `agent_setup_failed`, `api_error`, `agent_timeout`, `max_turns`, `tool_timeout`, `verifier_failed`, `agent_crashed`, and `unknown`. Counts in `report.json` group those into `passed`, `failed`, `infra_failed`, `timeout`, `api_error`, and `unknown`.

Benchmark reports include `suggested_owner` for each task to guide follow-up fixes. Unless it points to `portable/harbor` or `scripts/bench`, do not prioritize changes to Harbor adapter plumbing.

Validation, retry, precheck, cleanup, and attempt summaries are owned by `packages/agent-core` and exposed through `agent solve` harness flags. The portable Harbor runtime only forwards benchmark kwargs to the CLI and mirrors artifacts.

Harbor executable resolution is explicit and recorded in `config.json`: set `HARBOR_BIN` to force a specific CLI path; otherwise the runner checks common Windows uv/local install paths before falling back to `harbor` on PATH.

Terminal-Bench timeouts are resolved from Harbor task metadata before non-oracle runs. The runner probes the selected task set, then runs Harbor with a resolved JobConfig that uses the same task list. MVP defaults are intentionally lenient: `agent_wall_time_sec = max(recommended * 1.5, recommended + 600s)`, then Harbor's outer agent timeout adds `AGENT_TIMEOUT_GRACE_SEC` (default `120`). Override the internal agent wall time with `AGENT_MAX_WALL_TIME_SEC`; tune leniency with `AGENT_TIMEOUT_LENIENCY_MULTIPLIER` and `AGENT_TIMEOUT_LENIENCY_MIN_EXTRA_SEC`.

Current limitations:

- Packaging needs a pre-downloaded or cached Linux Node runtime tarball; the resulting Harbor artifact does not need system Node in the task container.
- `bench:tb:task` writes a Harbor JobConfig and does not depend on task-selection CLI flags, but still records detected CLI capabilities for diagnostics.
- Reports include per-task verifier reward and failed test details when Harbor writes `verifier/ctrf.json` or `verifier/test-stdout.txt` under the configured jobs directory.
- Reports mark stale run directories as `incomplete` when `config.json` is still running or expected logs are missing.

## CLI Flags

`agent solve` supports:

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
--max-tool-output-chars <number>
--max-message-history-chars <number>
--message-history-retain <number>
--compaction-summary-chars <number>
--validation-mode <off|auto>
--validation-retry-limit <number>
--validation-timeout-sec <number>
--precheck-command <command>
--precheck-timeout-sec <number>
--pre-verifier-cleanup-globs <comma-separated-globs>
--harness-timeout-sec <number>
--retry-min-budget-sec <number>
--attempts-dir <path>
--no-stream-ui
```

Config precedence is CLI flags, environment variables, `.agent/config.toml`, `~/.agent/config.toml`, then defaults. TOML support is intentionally minimal for MVP scalar values.

Local `agent solve` defaults to `--validation-mode off`. Benchmark runners pass `--validation-mode auto` plus retry, precheck, cleanup, and attempts settings when those harness behaviors are wanted.

## Tools

The core loop exposes four tools to the model:

- `bash`: runs `bash -lc` in the workspace, captures stdout/stderr/exit code/duration, times out safely, and truncates large output with a head/tail strategy.
- `read`: reads workspace files with optional offset and limit; binary files return metadata instead of raw bytes.
- `write`: writes UTF-8 files inside the workspace.
- `edit`: exact string replacement with optional `expectedReplacements`.

Paths are resolved relative to the workspace and rejected if they escape it. In non-interactive `ask` mode, mutating tools are rejected with a clear error. Benchmarks should use `--permission-mode yolo`.

## Summary JSON

`agent solve` writes:

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
  "validation_commands": ["python check_cert.py"],
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
    "pre_verifier_cleanup": null
  }
}
```

When the harness performs multiple attempts, the top-level count and token fields are aggregated across attempts. Per-attempt summaries and traces are preserved under the configured `attempts` directory.

## Harbor And Terminal-Bench 2.0

The Sigma agent runtime is built from `packages/agent-ai`, `packages/agent-core`, and `packages/agent-cli`. `pnpm package:agent-cli` turns those packages into a portable Linux CLI tarball for task containers. `pnpm package:harbor-runtime` then creates the host-side portable Harbor runtime and JobConfigs in:

```text
.artifacts/harbor-runtime/
  sigma_harbor_agent.py
  README.md
  jobconfig.deepseek.k5.json
  jobconfig.deepseek.task.example.json
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

For a single task example:

```bash
PYTHONPATH="$PWD/.artifacts/harbor-runtime" \
harbor run --config .artifacts/harbor-runtime/jobconfig.deepseek.task.example.json
```

Generated JobConfigs import `sigma_harbor_agent:SigmaCliHarborAgent` and include an absolute `agent_cli_tarball` path such as `.artifacts/agent-cli-linux-x64.tgz`. They should not require:

```bash
PYTHONPATH="$PWD"
```

They should not depend on:

```text
integrations.harbor.agent:AgentCliHarborAgent
```

unless legacy mode is explicitly requested.

The portable Python adapter depends only on the Python standard library and Harbor. It uploads the agent CLI tarball, extracts it to `/opt/agent-cli`, symlinks `/usr/local/bin/agent`, runs `/usr/local/bin/agent solve`, forwards provider env keys, downloads `/tmp/agent/summary.json`, `/tmp/agent/trace.jsonl`, and best-effort `/tmp/agent/attempts/**`, and fills Harbor context fields. Validation, retry, precheck, and cleanup behavior lives in `agent-core` and is controlled through CLI flags.

The convenience benchmark commands still work and now default to the portable runtime:

```bash
pnpm bench:tb:deepseek:k5
pnpm bench:tb:deepseek:task -- --task-id openssl-selfsigned-cert
```

During these runs, `scripts/bench-terminal-bench.mjs` packages the agent CLI, packages the Harbor runtime, puts `.artifacts/harbor-runtime` on `PYTHONPATH`, writes a portable JobConfig, runs Harbor, and collects reports.

`integrations/harbor` remains as a legacy/development helper and compatibility import. It is not the default benchmark runtime. To opt into the old import path:

```bash
SIGMA_HARBOR_AGENT_MODE=legacy pnpm bench:tb:deepseek:k5
```

or set:

```bash
SIGMA_HARBOR_AGENT_IMPORT_PATH=integrations.harbor.agent:AgentCliHarborAgent
```

Only legacy mode adds the repo root to `PYTHONPATH`.

`NODE_RUNTIME_TARBALL` must point at a pre-downloaded Linux Node tarball for the target architecture when packaging the CLI. By default packaging targets `x64`; set `AGENT_TARGET_ARCH=arm64` for an arm64 artifact. If `NODE_RUNTIME_TARBALL` is unset, the package script looks for `.artifacts/cache/node-v22.16.0-linux-x64.tar.xz` or the matching arm64 cache file and fails with instructions if it is missing.

Artifact checks:

```bash
pnpm package:agent-cli
tar -tzf .artifacts/agent-cli-linux-x64.tgz | grep 'bin/agent'
tar -tzf .artifacts/agent-cli-linux-x64.tgz | grep 'bin/node'
grep -R "integrations.harbor.agent" .artifacts/harbor-runtime
```

The adapter forwards `DEEPSEEK_API_KEY`, `GLM_API_KEY`, `ZAI_API_KEY`, `BIGMODEL_API_KEY`, `DEEPSEEK_BASE_URL`, `GLM_BASE_URL`, and `ZAI_BASE_URL` into the task container.

## TODOs And MVP Limits

- Streaming is not implemented yet; non-streaming chat completions are the supported path.
- Config TOML parsing supports simple top-level scalar keys only.
- The bundled Harbor artifact contains a Linux Node runtime when `NODE_RUNTIME_TARBALL` or the documented cache file is available at package time.
- Permission mode `ask` is non-interactive and conservative; it rejects mutating tools instead of prompting.
