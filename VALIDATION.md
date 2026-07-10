# Sigma Code 2.0 validation

Run release checks from the repository root with Node `24.18.0`. The exact pin is shared by `.node-version`, the root package, CI, and the portable packager. A lower local Node may run some tests but is not release evidence.

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
pnpm verify:sandbox
pnpm verify:package:agent-cli
pnpm perf:repo-100k
pnpm package:harbor-runtime
pnpm product:readiness
```

What these commands prove:

- `smoke:product`: a fake gateway completes a normal multi-turn tool/session workflow through the built CLI.
- `smoke:tui-product`: the built TUI exercises alternate-screen, cursor, raw-mode, completion, cleanup, and responsive-resize behavior with controlled terminal streams.
- `verify:sandbox`: lexical and symlink/junction workspace escapes are rejected and a cancelled process tree returns in under one second in that check.
- `verify:package:agent-cli`: the default Linux portable archive contains the manifest-derived dependency closure, wrapper, metadata, and pinned runtime; verification runs the bundled CLI entry with host Node and attempts the target wrapper when the native/WSL environment supports it.
- `package:harbor-runtime`: packages the already-built CLI archive with the external Harbor adapter; it does not add Harbor behavior to the solving runtime.
- `product:readiness`: evaluates generated smoke/package evidence. It distinguishes internal readiness from release readiness.

`pnpm verify:product` combines lint, coverage, fake product/TUI smoke, Windows package structure inspection, and the readiness report. It deliberately excludes benchmark execution and a live provider call, and it does not require a successful target-wrapper execution result.

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
- child scheduling, durable FIFO follow-ups, parent cancellation/join behavior, crash-visible unresolved children, clean-repository worktrees, dirty/non-Git single-writer leases, delegated approval capabilities, scoped integration, and integration conflicts;
- MCP initialize/tools/call flows, repository trust/digest invalidation, cwd containment, environment-secret isolation, malicious-config preflight, progress, pagination, protocol errors, cancellation, idle/deadline distinction, stderr bounds, shutdown, and tool-policy bridging;
- CLI strict config precedence, init/replay/session commands, active-owner routing, output formats, exit codes, interactive approval, and provider failure;
- TUI grapheme editing, CJK/emoji/flags/keycaps, bracketed paste, control-sequence sanitization, multiple approvals, queue routing, resize/cleanup, 10,000-event projection, render p95 under 16 ms in the unit-test environment, and heap growth under 150 MiB in that test;
- packaged TUI startup and cleanup through a real Linux PTY and Windows ConPTY in CI;
- a synthetic 100,000-path Git index through the production repository-context provider, bounded to 30 seconds and 300 MiB incremental heap;
- manifest-derived portable packaging and absence of the removed legacy packages;
- the production evaluation/fairness boundary.

## Boundaries not established by the automated gate

Do not interpret the checks above as claims beyond their scope:

- Sigma enforces workspace path containment and process cancellation, but does not currently configure an OS-level command sandbox. `agent doctor` reports this as a warning.
- CI exercises packaged `/quit` startup and cleanup through Linux PTY and Windows ConPTY. It does not replace manual IME, rapid-resize, font, and terminal-emulator matrix signoff.
- A trusted MCP process still runs with the user's OS authority. Repository MCP requires path-and-digest-bound trust and receives a restricted environment, but policy cannot independently prove what a remote server does.
- A dirty/non-Git writer runs under an exclusive lease in the source workspace, not an isolated worktree. In that mode only path-addressable writes inside its required `writeScope` are allowed; broad process/MCP mutation tools are denied.
- The default CI/product gate uses fake gateways. Only the explicit provider smoke proves current credentials and provider connectivity.
- Cross-target package structure verification does not execute a foreign-platform wrapper.

## Fairness audit

The fairness test scans every production package and rejects benchmark names, task identity, verifier feedback, rewards/scores, and related control flow. `agent-core` and `agent-ai` must remain absent.

Evaluation data has a separate protocol/storage path: `ExternalEvaluationReport` can be appended to an `EvaluationSink`, but `external_verifier` is excluded from solver-visible event and context authority types. The neutral product gate may launch and observe a run; it may not feed post-run evaluation output back into the agent or retry the solver from that output.
