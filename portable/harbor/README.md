# Sigma Harbor adapter

The adapter receives the Harbor trial timeout as generic metadata
(`outer_trial_deadline_sec`) when the benchmark runner can provide it. The
agent child deadline is capped at:

```text
child_deadline <= outer_trial_deadline - cleanup_grace
```

If Harbor does not expose an outer timeout, the configured Sigma wall time is
used and the adapter still reserves its cleanup grace. The calculation is
based only on timeout metadata and configuration; it does not inspect task
identity, verifier output, or benchmark answers.

The setup preflight invokes `agent doctor --check-api`. Its JSON result records
provider, model, endpoint host, latency, and a bounded error summary without
API keys. On timeout or cancellation, local `timeout.json`, `summary.json`,
`trace.jsonl`, and bounded `stdout.partial.log`/`stderr.partial.log` files are
written before the original Harbor timeout/cancellation is propagated.
