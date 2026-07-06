# Harbor Integration

`agent.py` defines `AgentCliHarborAgent`, a custom Harbor agent that runs:

```bash
/usr/local/bin/agent solve \
  --workspace /app \
  --instruction-file /tmp/agent/instruction.md \
  --provider deepseek \
  --model deepseek-v4-pro \
  --max-turns 40 \
  --command-timeout-sec 120 \
  --permission-mode yolo \
  --trace-jsonl /tmp/agent/trace.jsonl \
  --summary-json /tmp/agent/summary.json \
  --no-stream-ui
```

The simplest setup is to bake Node and the built `agent` CLI into the Harbor task image at
`/usr/local/bin/agent`. Alternatively, set `AGENT_CLI_DIR` or `AGENT_CLI_TARBALL` before Harbor
setup so the adapter can upload and install it.

Forward provider keys through the host environment:

```bash
export DEEPSEEK_API_KEY=...
# or
export ZAI_API_KEY=...
```

Harbor APIs have varied across versions, so the adapter tries common environment methods such as
`run`, `exec`, `upload`, and `download`. Adjust those small wrappers if your installed Harbor
version uses different names.
