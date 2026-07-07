# Validation

Date: 2026-07-07

## Commands Run

| Command | Status |
| --- | --- |
| `pnpm build` | PASS |
| `pnpm test` | PASS: Vitest suite and `python -m unittest tests.test_harbor_agent` |
| `pnpm lint` | PASS |
| `pnpm smoke:local:fake` | PASS |
| `node packages\agent-cli\dist\index.js --help` | PASS |
| `node packages\agent-cli\dist\index.js doctor --workspace .` | PASS |
| `node packages\agent-cli\dist\index.js replay --trace-jsonl .artifacts\smoke-local\create-file\trace.jsonl` | PASS |

## Smoke Tasks

`pnpm smoke:local:fake` passed all deterministic local tasks:

| Task | Status |
| --- | --- |
| `create-file` | PASS |
| `edit-file` | PASS |
| `fix-test` | PASS |
| `inspect-and-summarize` | PASS |

Artifacts were written under `.artifacts/smoke-local/`.

## Feature Coverage

This validation covers:

- Extensible tool registry injection, merging, filtering, and duplicate-name rejection.
- New tools: `list`, `glob`, `grep`, `git_status`, `git_diff`, `apply_patch`, and `todo`.
- Permission decider behavior for `ask`, `yolo`, denial, allow, and per-run `always_allow`.
- Project instruction loading from AGENTS/SIGMA-style files.
- Deterministic repo-map prompt context.
- Live stderr stream UI and `--no-stream-ui`.
- CLI config flags/env/config plumbing for tools, context, MCP, and stream UI.
- Stdio MCP v0 with fake server lifecycle, tool listing, tool calls, timeouts, filtering, disabled servers, and approval policy.
- Summary JSON optional fields for tools, changed files, todos, project instruction sources, context mode, repo-map size, and MCP servers.
- Secret redaction for traces, summaries, stream UI, final output, and approval prompts.
- Existing Harbor unit tests and fake-provider smoke tasks.

## Known Limitations

- MCP v0 supports local stdio servers only; HTTP/OAuth MCP is future work.
- Repo maps are static, deterministic context blocks. They do not use embeddings or a vector database.
- Stream UI is event-based and does not require provider token streaming. Provider SSE streaming remains optional future work.
- Config TOML parsing remains intentionally minimal: top-level scalar values and comma-separated list strings.
