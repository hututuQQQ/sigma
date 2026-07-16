# Sigma Code 3.0.0-rc.1 validation

Run release checks from the repository root with Node `26.4.0`. The exact pin is shared by `.node-version`, the root package, CI, and the portable packager. TUI checks also require `--experimental-ffi`; a lower local Node may run some tests but is not release evidence.

```powershell
node --version
corepack enable
corepack prepare pnpm@11.7.0 --activate
pnpm install --frozen-lockfile
pnpm build
```

## Required code-quality and test gates

```powershell
pnpm lint
pnpm test:coverage
pnpm test:harbor
```

`pnpm lint` includes:

- project-reference TypeScript checking;
- ESLint with cyclomatic complexity at most 15 and package-source functions at most 80 lines;
- dependency-cruiser checks for production dependency cycles and cross-package private-source imports;
- Knip dead-code/export checks;
- the architecture guard: production package files at most 400 lines and TUI source files at most 250 lines.

The V8 coverage gate includes every `packages/*/src/**/*.{ts,tsx}` file and currently requires:

- global statements, lines, functions, and branches: at least 80%;
- `agent-kernel` branch coverage: at least 90%;
- `agent-protocol` branch coverage: at least 90%;
- `agent-store` branch coverage: at least 90%.

The authoritative result is the current `pnpm test:coverage` run, not a number copied into documentation. Coverage reports are emitted under `coverage/` for inspection.

## Product and platform checks

Run the neutral product checks without live provider credentials:

```powershell
pnpm smoke:product
pnpm smoke:tui-product
pnpm verify:containment
pnpm verify:package:agent-cli:linux
pnpm perf:repo-100k
pnpm perf:replay-v4-100k
pnpm package:harbor-runtime
pnpm product:readiness -- --internal-only
```

What these commands prove:

- `smoke:product`: a fake gateway completes a normal multi-turn tool/session workflow through the built CLI.
- `smoke:tui-product`: the built OpenTUI application starts with FFI and exercises alternate-screen, cursor, raw-mode, completion, cleanup, and responsive resize with controlled terminal streams.
- `verify:containment`: lexical and symlink/junction workspace escapes are rejected and a cancelled process tree returns in under one second in that check. This command does not claim process isolation.
- `verify:package:agent-cli:linux`: the Linux portable archive contains the manifest-derived dependency closure, wrapper, metadata, and pinned runtime and must execute its target wrapper.
- `verify:package:agent-cli:windows`: the Windows portable archive provides the equivalent native-wrapper proof; `verify:package:agent-cli:windows:structure` is structure-only and is not release evidence.
- `perf:replay-v4-100k`: validates segmented V4 reads, envelope validation, reducer replay, snapshot rebuild, and tail replay over 100,000 events.
- `package:harbor-runtime`: packages the already-built CLI archive with the external Harbor adapter; it does not add Harbor behavior to the solving runtime.
- `product:readiness`: evaluates generated smoke/package evidence. It distinguishes internal readiness from release readiness.

`pnpm verify:product` combines only platform-neutral lint, coverage, fake product/TUI smoke, and internal readiness. Target archive, wrapper, sandbox, provider smoke, replay performance, and release readiness belong to `verify:release:linux` or `verify:release:windows`.

## Windows release check

On Windows, with provider credentials configured, run:

```powershell
pnpm verify:release:windows
```

This requires successful execution of the bundled Windows wrapper and a live DeepSeek provider smoke in addition to the neutral product checks. A structure-only Windows archive produced on another OS does not prove that the Windows wrapper executed successfully.

Live provider validation is intentionally separate because it costs money, depends on credentials/network/provider state, and is not a deterministic PR gate.

## Covered failure and recovery boundaries

The automated suites cover:

- DeepSeek/GLM request serialization, retryable HTTP failures, `Retry-After`, stream aggregation/divergence, partial-stream restart, finish reasons, idle timeout, hard deadline, and cancellation;
- kernel reducer decisions and the `complete_task` acceptance/evidence protocol;
- checksummed segment rotation, concurrent append serialization, corrupt/torn tails, snapshots, artifacts, and stale append locks;
- multi-run restore, durable deadlines, outcome-pending recovery, active-session ownership, command inboxes, pending approvals, and interrupted idempotent/non-idempotent tools;
- effect-based permission/mode decisions, per-call contexts, resource locking, process cancellation, tool failures, workspace delta receipts, and nested `AGENTS.md` discovery;
- stale model/tool/outcome rejection after steering, protocol-safe closure of superseded tool calls, nested-instruction replan-before-write-or-completion, delegated write-scope enforcement, and tool idle/hard deadlines;
- current-run-only completion receipts, same-turn completion barriers, strict met-criterion evidence, CJK/Unicode repository retrieval, provider-sized token fitting, atomic tool-call/result compaction, bounded large outputs, Git-root/workspace containment, symlink/junction containment, and cache invalidation;
- typed user-input suspension, bounded natural-stop repair, repeated tool-batch detection, run-wide tool-call ID uniqueness, child follow-up quiescence, and durable joined-child evidence recovery;
- child scheduling, durable FIFO follow-ups, parent cancellation/join behavior, crash-visible unresolved children, clean-repository worktrees, dirty/non-Git single-writer leases, delegated approval capabilities, scoped integration, and integration conflicts;
- MCP initialize/tools/call flows, repository trust/digest invalidation, cwd containment, environment-secret isolation, malicious-config preflight, progress, pagination, protocol errors, cancellation, idle/deadline distinction, stderr bounds, shutdown, and tool-policy bridging;
- CLI strict config precedence, init/replay/session commands, active-owner routing, output formats, exit codes, interactive approval, and provider failure;
- OpenTUI character/style frames at 20×5, 60×12, 80×24, and 120×40; streaming Markdown/code, CJK/emoji/combining input, bracketed paste, history, command completion, scroll/mouse routing, overlays, approvals, steering/follow-ups, double Ctrl+C, and terminal-control sanitization;
- 10,000-event projection with keyed incremental updates under 100 ms, long streaming-message update/render stages under 150 ms, and heap growth under 150 MiB in the unit-test environment;
- packaged TUI startup and cleanup through a real Linux PTY and Windows ConPTY in CI;
- a synthetic 100,000-path Git index through the production repository-context provider, bounded to 30 seconds and 300 MiB incremental heap;
- recursive production-dependency packaging, nested-version preservation, target OpenTUI native selection, pinned Node/FFI wrapper startup, and absence of the removed legacy packages;
- the production evaluation/fairness boundary.

## Boundaries not established by the automated gate

Do not interpret the checks above as claims beyond their scope:

- Sigma defaults to required OS isolation and no process network. Linux uses namespace/Landlock/seccomp and Windows uses AppContainer when the native broker self-test succeeds. Execution fails closed when required isolation is unavailable; unsafe host execution needs both a home-level grant and a per-run request. `agent doctor` reports the actual backend and self-test state.
- CI exercises packaged `/quit` startup and cleanup through Linux PTY and Windows ConPTY. It does not replace manual IME, rapid-resize, font, and terminal-emulator matrix signoff.
- A trusted MCP process still runs with the user's OS authority. Repository MCP requires path-and-digest-bound trust and receives a restricted environment, but policy cannot independently prove what a remote server does.
- A dirty/non-Git writer runs under an exclusive lease in the source workspace, not an isolated worktree. In that mode only path-addressable writes inside its required `writeScope` are allowed; broad process/MCP mutation tools are denied.
- The default CI/product gate uses fake gateways. Only the explicit provider smoke proves current credentials and provider connectivity.
- Cross-target package structure verification does not execute a foreign-platform wrapper.

## Fairness audit

The fairness test scans every production package and rejects benchmark names, task identity, verifier feedback, rewards/scores, and related control flow. `agent-core` and `agent-ai` must remain absent.

Evaluation data has a separate protocol/storage path: `ExternalEvaluationReport` can be appended to an `EvaluationSink`, but `external_verifier` is excluded from solver-visible event and context authority types. The neutral product gate may launch and observe a run; it may not feed post-run evaluation output back into the agent or retry the solver from that output.
