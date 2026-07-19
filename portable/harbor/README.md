# Sigma Harbor adapter

The launcher chooses a Compose overlay from the requested execution backend.
Sandboxed execution loads only a minimal `main` hardening overlay; it does not
create sidecars or mount a container-engine socket. Container execution uses a
three-service Compose boundary:

- `sigma-control` runs the packaged Sigma CLI and is the only service that
  receives model credentials. It mounts the task workspace at `/app` with
  `nocopy`.
- `sigma-oci-broker` is the only service with the Docker/Podman socket. It
  selects exactly one labelled `main` in its own Compose project, pins the
  target/container/image identity, and revalidates that attestation before
  every broker request.
- Harbor's `main` is the only task execution target. It performs the initial
  named-volume copy-up at `/app` and receives only the read-only native helper;
  it never receives the agent package, model credentials, or engine socket.

All shell, package, service, and system-path operations are executed by the
broker inside `main`, so workspace and operating-system state remain in the
same container inspected by the verifier. A missing sidecar capability or a
changed target identity is a typed failure; container mode never falls back to
`main`, `sigma-control`, or the host process.

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
provider, model, endpoint host, latency, execution backend, engine, target ID,
target start time, image ID/digest, and attestation digest, plus a bounded error
summary without API keys. On timeout or cancellation, local `timeout.json`, `summary.json`,
`trace.jsonl`, and bounded `stdout.partial.log`/`stderr.partial.log` files are
written before the original Harbor timeout/cancellation is propagated.
