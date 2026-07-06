# Harbor Integration

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
  --no-stream-ui
```

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

For benchmark runs, the adapter can run a generic post-agent validation loop before the official
verifier. When `generic_validation_enabled` is set, it snapshots the `/app` manifest before and after
the agent run, executes any `validation_commands` emitted in `/tmp/agent/summary.json`, and falls back
to syntax checks for changed `.py`, `.sh`, and `.js` files plus short runs of changed `check_*`,
`verify_*`, `validate_*`, and `test_*` scripts. Failures can consume `precheck_retry_limit` retry
budget and are fed back to the next agent attempt with command, exit code, stdout/stderr tails,
related files, and the previous summary. The Terminal-Bench wrapper enables this generic validation
and one retry by default for non-smoke runs; it does not read or mirror official task verifier tests.

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
