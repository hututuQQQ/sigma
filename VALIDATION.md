# Validation

Date: 2026-07-08

## Commands Run

| Command | Status |
| --- | --- |
| `pnpm build` | PASS |
| `pnpm lint` | PASS |
| `pnpm test` | PASS |
| `pnpm test:harbor` | PASS: `Ran 8 tests` |
| `pnpm --filter agent-tui build` | PASS |
| `pnpm --filter agent-tui start -- --help` | PASS: printed TUI usage and commands |
| `pnpm package:harbor-runtime` | PASS: created `.artifacts\harbor-runtime` |
| `rg -n "harness validation\|failed harness validation\|previous attempt failed harness\|verifier\|evaluator\|terminal-bench\|harbor" packages/agent-core packages/agent-tui` | PASS: no matches |
| `rg -n "agent-tui\|packages/agent-tui\|workspacePackages" scripts/package-agent-cli.mjs tests/package-agent-cli.test.ts` | PASS: no matches |
| `Get-ChildItem scripts -Filter 'bench-*'` | PASS: `bench-common.mjs`, `bench-report.mjs`, and `bench-terminal-bench.mjs` are present |
| `node -e "const p=require('./package.json'); for (const k of ['bench:tb:smoke','bench:tb:k','bench:tb:task','package:harbor-runtime','test:harbor']) console.log(k+'='+p.scripts[k])"` | PASS: benchmark, packaging, and Harbor test scripts still exist |

## Coverage Notes

- Retry feedback sent to the next model attempt now says "post-run checks" and the agent-core test asserts the generated retry instruction does not contain the old term.
- `agent-core` exports run-controller aliases while retaining the existing harness-named API for adapters and scripts.
- Harbor adapter tests cover canonical run-controller kwargs and assert `/usr/local/bin/agent run` is used.
- Product packages do not expose evaluator/verifier/Terminal-Bench/Harbor terms in `packages/agent-core` or `packages/agent-tui`.
- The Harbor/Terminal-Bench adapter files and benchmark npm scripts remain in place. `package-agent-cli.mjs` still has no `agent-tui` package inclusion.

## Known Limitations

- TUI updates are event-based at turn/tool granularity, not token delta streaming. Core has run-controller event types and a pre-model abort check, but provider token streaming, TUI token rendering, mid-model cancellation, and mid-tool cancellation are future work.
