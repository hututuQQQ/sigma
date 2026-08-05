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

Adapter-owned structured summaries and traces use schema 1 and current,
unversioned artifact names. The formal task boundary accepts
`provenance_source` only; removed field aliases are not reconstructed for the
solver.

`verifier_gate_plugin:VerifierGatePlugin` is a neutral host-side Harbor plugin
that applies a run-scoped, cross-process file-lock semaphore at verification
start. The benchmark launcher can also set verifier-only proxy variables in
Harbor's `verifier.env`; neither control inspects task names, agent output,
verifier output, rewards, or scores.

Formal runs freeze a non-decreasing verifier-concurrency schedule and may bind
a generic, non-shell bootstrap preflight by SHA-256. A failed preflight stops
before Harbor dispatch, so it cannot consume a benchmark attempt.

For ad-hoc Docker runs, verifier proxy mode `auto` reads Docker's advertised
HTTP proxy and records the resolved credential-free origin. It does not expose
a host-loopback proxy directly to containers. Formal runs must freeze that
resolved origin with proxy mode `custom` so host configuration cannot drift
between preregistration and execution.

`scripts/bench-verifier-egress-preflight.json` is the repository-managed
bootstrap descriptor. It SHA-binds its implementation and launches one cached,
ephemeral Ubuntu container per configured verifier slot. Every worker performs
a neutral APT package-index refresh, installs the common CA/curl bootstrap
tools, and completes a bounded HTTPS request. This exercises package-manager,
TLS, proxy, and concurrent Docker egress before any selected task is dispatched;
it does not inspect task identity, agent output, verifier output, or scores. A
failed concurrent cohort is retried once after a bounded delay, and the run is
released only when every verifier slot succeeds in the same cohort. Retry
counts and per-cohort outcomes are emitted in the preflight result. Benchmark
trials and post-verifier failures remain non-retriable.
