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
pnpm package:agent-cli
export AGENT_CLI_TARBALL="$PWD/.artifacts/agent-cli-linux.tgz"
```

The adapter uploads `AGENT_CLI_TARBALL`, extracts it in the task container, and links
`/usr/local/bin/agent`. This avoids running `pnpm install` inside every task container. You can
also bake Node and the built `agent` CLI into the Harbor task image at `/usr/local/bin/agent`.
`AGENT_CLI_DIR` is still available as a slower source-build fallback for development.

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
