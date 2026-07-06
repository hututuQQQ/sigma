# Harbor Integration

`integrations/harbor` is a legacy/development helper for Harbor and Terminal-Bench workflows. It is not the default runtime used by the benchmark runner.

The canonical portable adapter source is:

```text
portable/harbor/sigma_harbor_agent.py
```

`pnpm package:harbor-runtime` copies that source into:

```text
.artifacts/harbor-runtime/sigma_harbor_agent.py
```

Portable JobConfigs import:

```text
sigma_harbor_agent:SigmaCliHarborAgent
```

`integrations/harbor/agent.py` only re-exports the portable class as `AgentCliHarborAgent` for old configs that still reference:

```text
integrations.harbor.agent:AgentCliHarborAgent
```

Use that path only through explicit legacy mode:

```bash
SIGMA_HARBOR_AGENT_MODE=legacy pnpm bench:tb:deepseek:k5
```

The benchmark quality boundary has not changed:

- Agent behavior, retries, validation, compaction, timeout handling, and cleanup are owned by `packages/agent-core`.
- CLI flags, summary files, and trace output are owned by `packages/agent-cli`.
- Provider/API behavior is owned by `packages/agent-ai`.
- Benchmark orchestration and reports are owned by `scripts/bench-*.mjs`.
- This directory should only change for legacy import compatibility or Harbor-specific adapter plumbing.
