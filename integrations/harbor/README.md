# Harbor Integration

## Boundary

`integrations/harbor` is the Harbor / Terminal-Bench compatibility adapter for
Sigma. It is intentionally thin glue around the real CLI, agent loop, tools,
trace, summary, and provider layers.

**Do not improve benchmark score by editing this adapter unless the failure is
Harbor-specific.**

This directory is responsible for:

- Harbor agent class wrapper behavior.
- Installing or uploading the Sigma agent CLI artifact.
- Calling `/usr/local/bin/agent solve`.
- Forwarding required environment variables.
- Downloading or mirroring `summary.json`, `trace.jsonl`, metadata, and related
  benchmark artifacts.
- Filling Harbor context fields.

Change `integrations/harbor` only when the benchmark failure is caused by:

- Harbor CLI invocation errors.
- Agent artifact installation errors.
- Environment variables not being forwarded correctly.
- Harbor context or artifact plumbing errors.
- Task container setup glue errors.

For other failures, start in the owning layer instead:

- Prompt or agent behavior: `packages/agent-core`.
- Tool behavior: `packages/agent-core/src/tools`.
- Max turns, timeout, or compaction behavior: `packages/agent-core` or CLI config.
- Provider API or model calls: `packages/agent-ai`.
- CLI arguments, summary, or trace behavior: `packages/agent-cli` or
  `packages/agent-core`.
- Benchmark runner or report behavior: `scripts/bench-*.mjs`.

`agent.py` defines `AgentCliHarborAgent`, a custom Harbor agent that runs:

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
  --validation-mode auto \
  --validation-retry-limit 1 \
  --validation-timeout-sec 45 \
  --attempts-dir /tmp/agent/attempts \
  --no-stream-ui
```

The adapter accepts legacy Harbor JobConfig kwargs such as
`generic_validation_enabled`, `precheck_command`, `precheck_timeout_sec`,
`precheck_retry_limit`, `validation_timeout_sec`,
`pre_verifier_cleanup_globs`, `harbor_agent_timeout_sec`, and
`retry_min_budget_sec`, but it only converts them into CLI flags. Validation,
retry, precheck, cleanup, harness summaries, and attempt artifacts are owned by
`packages/agent-core` via `runAgentHarness`, with `packages/agent-cli` mapping
CLI flags into core config.

Future benchmark solving quality fixes should start in `packages/agent-core`,
the tools, prompts, or CLI configuration. Change this adapter only for Harbor
install, invocation, environment, context, or artifact plumbing problems.

The preferred setup is to build the bundled Linux artifact once on the host:

```bash
pnpm install
export NODE_RUNTIME_TARBALL=/path/to/node-v22.16.0-linux-x64.tar.xz
pnpm package:agent-cli
export AGENT_CLI_TARBALL="$PWD/.artifacts/agent-cli-linux-x64.tgz"
```

The package script copies Node from `NODE_RUNTIME_TARBALL`, or from
`.artifacts/cache/node-v22.16.0-linux-x64.tar.xz` when the env var is unset. Set
`AGENT_TARGET_ARCH=arm64` to build `.artifacts/agent-cli-linux-arm64.tgz`.

The adapter uploads `AGENT_CLI_TARBALL`, extracts it in the task container, links
`/opt/agent-cli/bin/agent` to `/usr/local/bin/agent`, and verifies readiness with
`/usr/local/bin/agent --help`. Task containers do not need system `node` when the artifact includes
`bin/node`. `AGENT_CLI_DIR` is still available as a slower source-build fallback for development.

For benchmark runs, the Terminal-Bench wrapper enables core-owned generic
validation and one retry by default for non-smoke runs. The core harness
snapshots the workspace manifest before and after each attempt, executes
`validation_commands` emitted in `/tmp/agent/summary.json`, falls back to syntax
checks for changed `.py`, `.sh`, and `.js` files plus short runs of changed
`check_*`, `verify_*`, `validate_*`, and `test_*` scripts, and writes the results
under `summary.harness`. The adapter mirrors the top-level `summary.json`,
`trace.jsonl`, and `attempts/**` artifacts when Harbor exposes download methods.

Artifact checks:

```bash
tar -tzf .artifacts/agent-cli-linux-x64.tgz | grep 'bin/agent'
tar -tzf .artifacts/agent-cli-linux-x64.tgz | grep 'bin/node'
```

Forward provider keys through the host environment:

```bash
export DEEPSEEK_API_KEY=...
# or
export ZAI_API_KEY=...
```

Terminal-Bench 2.0 smoke flow:

```bash
harbor run -d terminal-bench/terminal-bench-2 -a oracle -l 5

harbor run -d terminal-bench/terminal-bench-2 \
  --agent-import-path "integrations.harbor.agent:AgentCliHarborAgent" \
  -k 5
```

Targeted setup/runtime startup checks:

```bash
AGENT_PROVIDER=deepseek DEEPSEEK_API_KEY=... pnpm bench:tb:task -- --task-id openssl-selfsigned-cert
AGENT_PROVIDER=deepseek DEEPSEEK_API_KEY=... pnpm bench:tb:task -- --task-id regex-log
```
