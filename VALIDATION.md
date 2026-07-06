# Validation

Date: 2026-07-06

## Commands Run

| Command | Status |
| --- | --- |
| `pnpm install` | PASS |
| `pnpm build` | PASS |
| `pnpm test` | PASS |
| `pnpm lint` | PASS |
| `pnpm package:agent-cli` | PASS |
| `pnpm smoke:local:fake` | PASS |
| `pnpm smoke:local` | PASS with DeepSeek |
| `AGENT_PROVIDER=glm AGENT_MODEL=glm-5.2 pnpm smoke:local` | PASS with GLM |
| `pnpm smoke:harbor` | NOT RUN: Harbor missing; helper failed clearly before benchmark execution |

## Local Smoke Tasks

Fake-provider smoke passed all tasks through `runAgent` and the normal workspace tools:

| Task | Status |
| --- | --- |
| `create-file` | PASS |
| `edit-file` | PASS |
| `fix-test` | PASS |
| `inspect-and-summarize` | PASS |

Artifacts were written under `.artifacts/smoke-local/`.

## Optional Smokes

Real provider local smoke was run with DeepSeek using `deepseek-v4-pro`; all four local smoke tasks passed.

Real provider local smoke was also run with GLM using `glm-5.2`; all four local smoke tasks passed.

Harbor smoke was not run because `harbor` was not installed on PATH in this environment. `pnpm smoke:harbor` was invoked and failed clearly with installation guidance before any benchmark execution.

## Known Limitations

- The Harbor tarball still requires `node` inside the task container. Setup now fails clearly if Node is missing.
- A future artifact should bundle Node or become a true single-file binary.
- Fake smoke is deterministic and task-specific; real provider quality still depends on credentials and model behavior.
