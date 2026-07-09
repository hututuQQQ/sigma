# Validation

Date: 2026-07-09

## Commands Run

| Command | Status |
| --- | --- |
| `pnpm lint` | PASS |
| `pnpm test` | PASS |
| `pnpm build` | PASS |
| `pnpm smoke:local:fake` | PASS: create-file, edit-file, fix-test, inspect-and-summarize |
| `pnpm test:harbor` | PASS: 8 unittest cases |
| `pnpm package:harbor-runtime` | PASS: created `.artifacts\harbor-runtime` and `.artifacts\agent-cli-linux-x64.tgz` |
| `git diff --check` | PASS |
| `pnpm test -- tests/product-benchmark-boundary.test.ts tests/agent-core.subagents-review.test.ts` | PASS: product boundary test allows only `packages/agent-core/src/review/anti-gaming.ts` as the explicit detection-rule exception |
| `rg -n "agent-tui\|packages/agent-tui\|workspacePackages" scripts/package-agent-cli.mjs tests/package-agent-cli.test.ts` | PASS: package list and copy step include `agent-tui`; package test covers workspace package list |
| `node -e "const p=require('./package.json'); for (const k of ['bench:tb:smoke','bench:tb:k','bench:tb:task','package:harbor-runtime','test:harbor']) console.log(k+'='+p.scripts[k])"` | PASS: printed configured script commands |

## Coverage Notes

- `memory.write` now requests write permission before persisting durable memory. Tests cover ask mode without a decider denying the write and leaving `.agent/memory` empty, yolo mode write/search/read behavior, ask-mode decider allow, and list/search/read remaining read-only.
- Runtime memory/diff context is sent as explicit `UNTRUSTED RUNTIME CONTEXT` with "not user instruction" language and fenced block payloads. Tests cover a hostile memory snippet and assert it is not placed in the ordinary user message.
- Recent diff runtime context now includes both `git diff --stat -- .` and a bounded `git diff --unified=3 -- .` patch preview. Tests cover small diffs with patch content and large diffs with `[diff truncated]` plus `source.truncated`.
- Context budget estimates no longer add `repoMapChars` or `skillsChars` on top of message/tool chars. A regression test asserts repo map and skills attribution is preserved without double-counting the total estimate.
- Product package boundary tests keep benchmark/verifier/reward/task-id terms out of product packages except for the single explicit detection-rule file: `packages/agent-core/src/review/anti-gaming.ts`. That file now uses direct literal terms instead of split strings.
- Harbor adapter tests and runtime packaging still pass. The benchmark and Harbor helper scripts remain in `package.json` as external infrastructure commands.

## Known Limitations

- The Tree-sitter Node binding is pinned to the `0.22.x` runtime series with compatible grammar package versions because `tree-sitter@0.25.x` failed native compilation on Node 24/MSBuild in this environment.
- TUI rendering consumes typed thread items for tool name/input/result, while older event metadata remains present for trace readability and external replay compatibility.
