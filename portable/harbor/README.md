# Sigma Harbor adapter

The benchmark launcher groups selected trials by Harbor agent timeout. Each
group passes its uniform timeout to the adapter as generic metadata
(`outer_trial_deadline_sec`), and the agent child deadline is capped at:

```text
child_deadline <= outer_trial_deadline - cleanup_grace
```

This keeps Harbor's per-trial timeout authoritative without planning every
trial from the batch maximum. Group selection is control-plane infrastructure:
the solving agent receives only its deadline, never task identity, verifier
output, or benchmark answers.

The setup preflight invokes `agent doctor --check-api`. Its JSON result records
provider, model, endpoint host, latency, and a bounded error summary without
API keys. On timeout or cancellation, local `timeout.json`, `summary.json`,
`trace.jsonl`, and bounded `stdout.partial.log`/`stderr.partial.log` files are
written before the original Harbor timeout/cancellation is propagated.
