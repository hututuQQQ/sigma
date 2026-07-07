# Validation

Date: 2026-07-07

## Commands Run

| Command | Status |
| --- | --- |
| `pnpm install` | PASS: refreshed workspace links for `packages/agent-tui` |
| `pnpm build` | PASS |
| `pnpm lint` | PASS |
| `pnpm test` | PASS: Vitest only; Harbor adapter tests are not part of the root test script |
| `pnpm test:harbor` | PASS: `Ran 8 tests` |
| `pnpm test:all` | PASS: ordinary tests plus Harbor adapter tests |
| `pnpm --filter agent-tui build` | PASS |
| `pnpm --filter agent-tui start -- --help` | PASS: printed TUI usage and commands |
| `rg -n "evaluator\|verifier\|benchmark\|terminal-bench\|harbor" packages\agent-core packages\agent-tui` | PASS: no matches |
| `pnpm package:harbor-runtime` | PASS: created `.artifacts\harbor-runtime` |
| `node -e "const p=require('./package.json'); if(!p.scripts['bench:tb:deepseek:k5']) process.exit(1); console.log(p.scripts['bench:tb:deepseek:k5'])"` | PASS: script still exists |

## Coverage Notes

- Product packages no longer expose evaluator/verifier/benchmark/Harbor terms in core prompt, agent loop, run controller, or TUI runtime.
- Assistant final text is not parsed for validation commands. Validation comes from explicit config/CLI commands and the changed-file strategy.
- Harbor adapter tests cover canonical kwargs: `validation_mode`, `validation_retry_limit`, `validation_timeout_sec`, `precheck_command`, `precheck_timeout_sec`, `post_run_cleanup_globs`, and `harness_timeout_sec`.
- Root `pnpm test` is independent from the Harbor adapter suite; `pnpm test:harbor` and `pnpm test:all` cover the adapter path.
- TUI build and help output verify the new package entrypoint is wired into the workspace.

## Known Limitations

- TUI updates are event-based at turn/tool granularity. Token delta rendering is future work once `agent-core` emits assistant delta events from provider streaming.
- `pnpm package:agent-cli` was not rerun in this validation pass; `pnpm package:harbor-runtime` still generated the host-side portable runtime and JobConfig.
