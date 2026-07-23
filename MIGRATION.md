# Migration notes

## Network default

The default process network policy is now `full`.

- Existing workspaces that must remain offline should set `security.network = "none"` in
  `.agent/config.toml`, pass `--network none`, or set `SIGMA_NETWORK=none`.
- `loopback` and `full` remain explicit supported values.
- Interactive runs still require a fresh grant for every full-network call.
- Non-interactive runs use the existing auditable automatic-grant path.
- Startup now fails with `network_capability_unavailable` when the connected broker
  cannot provide the configured mode. Sigma does not silently downgrade `full` to
  an offline mode.

## Durable protocol

This change advances the independently versioned durable formats:

- event schema: V5 to V6;
- snapshot envelope: V6 to V7;
- kernel state: V6 to V7;
- store layout remains V5.

Event V6 adds `model.prompt_materialized`. The event records the exact scoped
dynamic message frame used for the immediately following assistant turn, together
with the canonical tool-schema digest, request digest, prefix message count, and
cache mode.

Kernel V7 adds durable output-truncation recovery state:

- `lastModelFinishReason`;
- `consecutiveLengthFinishes`;
- `consecutiveLengthNoAction`;
- `lastModelHadToolCalls`.

The segmented store accepts existing V5 events and V5/V6 snapshot envelopes.
Restoring a V5 or V6 kernel snapshot migrates it to V7, initializes the new
truncation fields conservatively, replays later events, and writes a V7 snapshot.
Appending a new event updates session metadata to the current event and snapshot
versions. Public snapshot validation remains strict V7 so new writers cannot
accidentally emit a legacy envelope.

No manual store rewrite is required. Back up long-lived state directories before
deploying as usual; older binaries will not understand newly appended V6 events.

## Tool contracts

`write` and `edit` receipts now include the resulting UTF-8 `byteLength` and
`sha256`. The new `write_chunk` tool atomically appends a chunk using an expected
preimage length and digest; replaying the same chunk returns `status=no_change`.

The `shell` tool accepts either the existing explicit shell form or
`{"command":"..."}`. When the shell is omitted, Sigma selects a deterministic
broker-verified shell for the platform.
