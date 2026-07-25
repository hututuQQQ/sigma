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

- event schema: V8 to V9;
- snapshot envelope: V9 to V10;
- kernel state: V9 to V10;
- frozen customization: V3 to V4;
- store layout remains V5.

Event V9 separates diagnostic preflight from substantive active review and
records review reservations, reviewer tool receipts, and terminal decision
authority. A completion or failure decision can now be attributed only to a
safety invariant, resource boundary, provider protocol, user policy, or an
independent verification verdict.

Kernel V10 replaces the semantic `4/8/6` progress counters with
`LongHorizonStateV2`. The new state retains only objective duplicate-call/result
detection, explicit model strategy requests, a resource-band signal, and the
configured assurance ledger. Validation sufficiency, task risk, and command
coverage are no longer inferred from file extensions, command names, or shell
syntax.

The long-horizon coordinator now also derives a bounded evidence-attention
window from the existing durable assistant/tool trajectory. This is a
context-resource signal rather than a persisted task-semantic counter: a real
plan update, validation, review, or new user instruction resets the window,
while distinct observations continue to consume it. A workspace mutation also
resets it when no explicit plan is active. With an active plan, arbitrary
mutations are not assumed to advance that plan: this prevents scratch outputs
from indefinitely hiding an unchanged work contract without classifying paths
or commands. On saturation, an adaptive profile invokes its one fresh-context
strategist and that model explicitly recommends continued exploration,
implementation, plan revision, validation, or a genuinely necessary user-input
request. A proposed user-input suspension while the model's own plan still has
open nodes receives the same one-time strategy audit before it can suspend; a
repeated request is still honored, and profiles can disable the strategist. No
wall-clock value, command classifier, tool restriction, or terminal decision is
introduced.
Because the window is reconstructed from existing messages and receipts,
Event V9, Kernel/Snapshot V10, and their recovery path remain unchanged;
pre-decision V10 strategy records stay valid.

Reviewer criterion evidence is now runtime-bound. New reviewer tool schemas no
longer ask the model to reproduce opaque evidence identifiers; the runtime
attaches authenticated current-frontier deltas, validations, environment
evidence, and reviewer checks. Legacy V10/V3 verdicts remain readable. During
normalization, unknown legacy references are discarded and counted, while an
approval still fails closed if any satisfied criterion has no authentic
evidence after resolution.

New active-review responses must also declare criterion-level evidence coverage:
`complete`, `partial`, or `unavailable`, together with checked claims,
limitations, and an attempted falsification. A `satisfied` declaration is
normalized to `unverified` unless coverage is complete and has no remaining
limitation. The declaration guides semantic review but does not manufacture
evidence: runtime still accepts only authenticated current-session,
current-frontier evidence. Stored V3 evidence keeps this field optional so
pre-upgrade audit records remain readable.

The segmented store accepts all previously supported event and snapshot
versions. Restoring a V9 kernel snapshot preserves messages, reasoning, tool
receipts and identifiers, mutation/frontier evidence, plan state, artifacts,
length recovery, and tool side-effect boundaries. The old semantic progress
counters and review approvals are not promoted to V10 authority: long-horizon
state is initialized conservatively, old reviews remain audit records, and an
unfinished current frontier receives a fresh V3 review. The next model turn
materializes a complete bounded runtime state frame and the next snapshot is
written as V10. Older snapshots continue through the same conservative
migration chain.

No tool side effect is replayed during migration. If a restored thinking-provider
history contains a complete assistant/tool block without the provider-required
reasoning field, the next request replaces that whole block in the model
projection with a digest-bound tombstone; the durable messages and receipts are
not rewritten.

No manual store rewrite is required. Back up long-lived state directories before
deploying as usual; older binaries will not understand newly appended V9 events.

## Plan and completion contracts

The model-visible `update_plan` input is now a checklist:

```json
{
  "explanation": "optional",
  "goal": "optional",
  "acceptanceCriteria": ["optional"],
  "plan": [
    {
      "id": "optional-stable-id",
      "step": "Implement the change",
      "status": "in_progress",
      "blockedReason": "required only when blocked"
    }
  ]
}
```

Revision, ownership, child dependencies, and evidence links are runtime-owned.
The former revisioned input remains accepted for one compatibility release but
is no longer advertised in the tool schema. Multiple active steps, a missing
active step, stable renames/reopens, blocked reasons, and omitted runtime
dependency anchors are normalized with warnings instead of consuming another
model turn.

Independent completion review now emits `VerificationVerdictV3` evidence from
an active, read-only verification session. The reviewer can page the
baseline-to-current consolidated change set and artifacts, read/search the
logical workspace, query LSP, and run checks in a disposable overlay. Preflight
is diagnostic only and never consumes one of the two substantive review rounds.
Standard runs with a non-empty mutation frontier require current-frontier
approval or an explicit current user waiver. The first substantive rejection
gets one repair episode; a second review occurs only when frontier, validation,
plan, or post-review tool evidence changed. Strict mode does not accept a
waiver and requires approval backed by a reviewer-executed current-frontier
check. Legacy V1/V2 review evidence remains readable for audit but is not a V3
completion approval.

`request_review` is now an explicit protocol barrier and must be issued alone.
Its first substantive rejection materializes the same single repair advisory
as natural-stop review. Repeating it without new objective evidence, or
receiving a non-approved verdict in the final configured substantive round,
ends immediately as typed `verification_failed`; ordinary solving is not
silently reopened after the review policy is exhausted.

The reviewer continues to see the parent's stable logical workspace path in its
fresh context. When a process check runs in a disposable overlay, runtime now
projects that logical root inside declared path arguments and process invocation
fields to the physical overlay root before preparing and executing the call.
This preserves command semantics without exposing or writing the parent
workspace; unrelated strings and paths outside the logical root are unchanged.
The review payload also supplies a session-stable `.sigma-review-scratch`
location under the logical root. Generated binaries and other cross-call check
artifacts should live there rather than in an external temporary directory so
later reviewer calls address the same overlay state.

`assurance.repair_max_turns` and `repair_max_tool_calls` retain their serialized
names for profile compatibility. Their defaults protect three model turns and
eight tool calls for the single substantive repair episode. Ordinary
pre-review solving cannot consume this capacity. Both counts are reserve
floors, not semantic stops: after either reaches zero, the natural tool loop
may continue from ordinary hard budget. Only actual hard-ledger tool
exhaustion produces a 2,048-token, no-tool synthesis turn so the model can
incorporate the latest receipts before the second review. The reviewer portion
of the assurance pool remains isolated for that review.

Assurance reservation is also bounded by work that can still legally run.
Completed substantive review rounds and an already-used strategist no longer
leave their unused model-turn, token, or cost allowance frozen. Once the final
substantive review settles, unused assurance and future-repair reserve returns
to the ordinary hard ledger (although the terminal review verdict still
governs whether the run may complete).

A reviewer response that cannot be parsed as either the verdict tool arguments
or one exact JSON object still fails closed with
`review_protocol_invalid`. A parseable but structurally incomplete response can
never approve completion: omitted acceptance criteria are materialized as
`unverified`, and the result becomes `changes_requested` so the existing repair
episode can address it. For providers that omit the final tool call, one exact
JSON object (optionally enclosed by a single JSON fence) is accepted; prose
surrounding JSON remains invalid.

When an active reviewer proposes `submit_verification` early in the same
parallel batch as another inspection, or supplies non-object verdict
arguments, runtime does not execute that ambiguous batch. If a reserved review
turn remains, it is used for one verdict-only protocol recovery with
`toolChoice=required`; an invalid final-boundary submission still fails closed.

Checkpoint review rendering is now stack-safe for large textual replacements.
Added or deleted text that cannot fit in the configured review envelope is
represented by its authenticated `content_omitted` identity without first
building an unbounded line diff. A renderer resource failure likewise records a
bounded workspace-delta evidence item so a successfully sealed mutation is
never reclassified as an interrupted checkpoint. Completion remains blocked if
a non-empty sealed checkpoint somehow lacks its durable workspace-delta
evidence.

Active verification now distinguishes Standard engineering assurance from
Strict proof policy. Standard preserves the reviewer's declared semantic
coverage instead of having runtime convert every partial check or residual
limitation into an automatic rejection; an unavailable external reference alone
is not a defect when an independent oracle, invariant, or adversarial check can
support the requirement. Strict retains complete-coverage/no-limitation
normalization. Whenever inspection tools are available and the review has at
least two turns, the verdict tool is withheld until the reviewer executes at
least one authenticated check.

The first active review also receives a bounded summary of the main session's
durable `process_*` receipts, including deliverable handoff records. Reviewer
checks run in an isolated process namespace, so their local process table is no
longer presented as evidence that a parent-session or handed-off process is
absent. Reviewers must use the durable lifecycle records plus an externally
observable readiness check. The receipt summary is evidence provenance and does
not itself decide semantic completion.

At an ordinary solver-budget boundary, the runtime now keeps waiting for
already-started session-lifecycle processes instead of terminating them before
completion review. This wait consumes neither model turns nor tool-call budget,
remains cancellable by the outer deadline, and does not include deliverable
processes that require explicit handoff. Incremental output, terminal state,
failure, hashes, previews, and any broker output artifacts become durable
current-session lifecycle evidence. The active reviewer can page those
artifacts and receives the lifecycle records in its consolidated change set.
Repeated broker references to the same output artifact are imported and
released exactly once.

A durable strategy reset is authoritative only for the progress basis on which
it was produced. Once a later objective receipt changes that basis, the reset
remains in the event log for audit but its facts and next actions are no longer
projected as current instructions. Evidence-attention input is ordered
oldest-to-newest and bounded to the newest representatives, so a strategist
does not plan from an obsolete early exploration result.

## Tool contracts

`write` and `edit` receipts now include the resulting UTF-8 `byteLength` and
`sha256`. The new `write_chunk` tool atomically appends a chunk using an expected
preimage length and digest; replaying the same chunk returns `status=no_change`.

The `shell` tool accepts either the existing explicit shell form or
`{"command":"..."}`. When the shell is omitted, Sigma selects a deterministic
broker-verified shell for the platform.

When the broker attests a disposable enclosing container and background
execution is available, `environment_process_spawn` provides the background
counterpart to `environment_shell`. The runtime supplies the enclosing
container write boundary and keeps the workspace plus Sigma runtime read-only,
so the model does not have to reconstruct `access`, `writeRoots`, and
`expectedChanges` for ordinary disposable services. Session processes remain
runtime-owned. A deliverable process still requires an explicit
`process_handoff`; the handed-off process retains its broker sandbox and cannot
write the protected workspace or runtime.

Linux brokers now advertise sandbox-owned executable resolution. When present,
bare aliases and explicit paths are resolved, pinned, and authorized by
`sigma-exec`; the bounded runtime command list is an availability hint rather
than a client-side command-name gate. Windows retains its narrower client
precheck and native executable identity rules.

Non-UTF-8 process output no longer erases an otherwise valid exit result.
`sigma-exec` preserves the broker-redacted bytes as a bounded output artifact,
while the model receives a deterministic non-text notice, artifact identity,
exit status, and `invalid_output_encoding:<stream>` diagnostic. Artifact
references use `application/octet-stream` when necessary and can be read through
the existing paged artifact tool. A legacy broker that cannot supply the bytes
still returns the exit result with an explicit "exact bytes unavailable"
notice.

`inspect_image` is a read-only, offline fallback for text-only model providers.
It accepts a workspace-contained raster image (or an explicitly approved
external input), freezes byte length and SHA-256 through the same stable path
lease as `read`, and returns bundled English OCR text plus non-authoritative
format and confidence metadata. PNG, JPEG, GIF, WebP, BMP, TIFF, and PNM byte
signatures are accepted up to 16 MiB. The OCR engine and language data are
packaged with Sigma; no runtime download or workspace cache write is performed.
Existing tool-policy and reviewer sandboxes admit it solely as
`filesystem.read`.

`inspect_document` adds the corresponding read-only PDF path for text-only
providers. It extracts embedded text first and can render image-only pages for
the same bundled English OCR engine. Calls are bounded to 32 MiB inputs, at most
25 selected pages and 10 OCR pages, and expose explicit page plus UTF-8 byte
continuations. The PDF parser receives in-memory bytes with streaming, automatic
fetches, XFA, system fonts, and workspace writes disabled. Returned page source,
confidence, byte length, and SHA-256 are objective inspection metadata rather
than completion evidence.
