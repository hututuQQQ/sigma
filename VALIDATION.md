# Validation

Date: 2026-07-09

## Commands Run

| Command | Status |
| --- | --- |
| `pnpm lint` | PASS |
| `pnpm test` | PASS |
| `pnpm build` | PASS |
| `pnpm smoke:local:fake` | PASS: create-file, edit-file, fix-test, inspect-and-summarize |
| `pnpm test -- tests/agent-core.loop.test.ts tests/agent-core.tools.test.ts tests/agent-core.code-graph-index.test.ts tests/agent-core.context.test.ts tests/agent-core.tool-runtime.test.ts tests/product-benchmark-boundary.test.ts tests/agent-tui.render.test.ts tests/agent-tui.formatters.test.ts` | PASS |

## Coverage Notes

- Retry feedback sent to the next model attempt now says "post-run checks" and the agent-core test asserts the generated retry instruction does not contain the old term.
- `agent-core` exports run-controller aliases while retaining the existing harness-named API for adapters and scripts.
- Harbor adapter tests cover canonical run-controller kwargs and assert `/usr/local/bin/agent run` is used.
- Product packages do not expose evaluator/verifier/Terminal-Bench/Harbor terms in `packages/agent-core` or `packages/agent-tui`.
- The Harbor/Terminal-Bench adapter files and benchmark npm scripts remain in place. `package-agent-cli.mjs` still has no `agent-tui` package inclusion.
- Tool protocol tests now cover descriptor-derived tool schemas, typed thread items, output artifacts, cancellation metadata, and private metadata not being serialized into model-visible tool messages.
- Context tests now cover `ContextSourceMap`, prompt-cache hints, deterministic/model compaction behavior, diff/memory injection, and Tree-sitter-backed graph indexing for TS/TSX/JS/Python/Go/Rust.
- Memory tests cover local `.agent/memory` write/search/read flows and keep memory content out of static repo facts.

## Known Limitations

- The Tree-sitter Node binding is pinned to the `0.22.x` runtime series with compatible grammar package versions because `tree-sitter@0.25.x` failed native compilation on Node 24/MSBuild in this environment.
- TUI rendering consumes typed thread items for tool name/input/result, while older event metadata remains present for trace readability and external replay compatibility.
