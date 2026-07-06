# Sigma Agent MVP

A small coding-agent monorepo inspired by Pi with only three layers:

- `packages/agent-ai`: provider-agnostic model interface for DeepSeek and GLM/Zhipu
- `packages/agent-core`: autonomous loop, JSONL tracing, session records, and workspace tools
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

The current Harbor artifact still requires `node` in the task container. Harbor setup now checks `command -v node` and `/usr/local/bin/agent --help`; if Node is missing, setup fails clearly instead of letting the task run with a broken agent. TODO: bundle Node with the artifact or produce a true single-file binary.

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
--no-stream-ui
```

Config precedence is CLI flags, environment variables, `.agent/config.toml`, `~/.agent/config.toml`, then defaults. TOML support is intentionally minimal for MVP scalar values.

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
  "last_error": null
}
```

## Harbor And Terminal-Bench 2.0

The Harbor adapter lives at `integrations/harbor/agent.py` and defines `AgentCliHarborAgent`.

The adapter writes the task instruction to `/tmp/agent/instruction.md` and runs:

```bash
/usr/local/bin/agent solve \
  --workspace /app \
  --instruction-file /tmp/agent/instruction.md \
  --provider deepseek \
  --model deepseek-v4-pro \
  --max-turns 200 \
  --command-timeout-sec 180 \
  --max-wall-time-sec 7200 \
  --permission-mode yolo \
  --trace-jsonl /tmp/agent/trace.jsonl \
  --summary-json /tmp/agent/summary.json \
  --no-stream-ui
```

Recommended Harbor setup:

```bash
pnpm install
pnpm package:agent-cli
export AGENT_CLI_TARBALL="$PWD/.artifacts/agent-cli-linux.tgz"
export DEEPSEEK_API_KEY=...
```

`AGENT_CLI_TARBALL` is the preferred Harbor path because setup uploads one built artifact and extracts it in the task container. This avoids running `pnpm install` inside every task. `AGENT_CLI_DIR` remains a development fallback when you want Harbor to upload the source tree and build it in the container.

Terminal-Bench 2.0 smoke flow:

```bash
# Verify the benchmark install with its oracle first.
harbor run -d terminal-bench/terminal-bench-2 -a oracle -l 5

# Then run the custom Harbor agent.
harbor run -d terminal-bench/terminal-bench-2 \
  --agent-import-path "integrations.harbor.agent:AgentCliHarborAgent" \
  -k 5
```

The adapter forwards `DEEPSEEK_API_KEY`, `GLM_API_KEY`, `ZAI_API_KEY`, `BIGMODEL_API_KEY`, `DEEPSEEK_BASE_URL`, `GLM_BASE_URL`, and `ZAI_BASE_URL` into the task container. It downloads `/tmp/agent/trace.jsonl` and `/tmp/agent/summary.json` into Harbor logs when the environment exposes a download method.

## TODOs And MVP Limits

- Streaming is not implemented yet; non-streaming chat completions are the supported path.
- Config TOML parsing supports simple top-level scalar keys only.
- The bundled Harbor artifact still assumes Node is available in the task container; setup fails clearly when it is missing.
- TODO: bundle Node with the Harbor artifact or produce a true single-file binary.
- Permission mode `ask` is non-interactive and conservative; it rejects mutating tools instead of prompting.
