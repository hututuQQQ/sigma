# Validation

Date: 2026-07-06

## Commands Run

| Command | Status |
| --- | --- |
| `pnpm install` | PASS |
| `pnpm build` | PASS |
| `pnpm test` | PASS: 45 Vitest tests and 16 Python Harbor tests |
| `pnpm lint` | PASS |
| `pnpm exec vitest run tests/bench-common.test.ts tests/agent-core.loop.test.ts` | PASS: 27 focused Vitest tests |
| `python -m unittest tests.test_harbor_agent` | PASS: 16 Python Harbor tests |
| `pnpm package:agent-cli` | PASS |
| `pnpm smoke:local:fake` | PASS |
| `tar -tzf .artifacts/agent-cli-linux-x64.tgz \| grep 'bin/agent'` | PASS via PowerShell `Select-String` |
| `tar -tzf .artifacts/agent-cli-linux-x64.tgz \| grep 'bin/node'` | PASS via PowerShell `Select-String` |
| Debian container with no system `node`: `/usr/local/bin/agent --help` | PASS |
| `AGENT_PROVIDER=deepseek AGENT_MODEL=deepseek-v4-pro DEEPSEEK_API_KEY=... pnpm bench:tb:task -- --task-id openssl-selfsigned-cert` | PASS setup/runtime startup; verifier failed 5/6 with `ModuleNotFoundError: No module named 'cryptography'` before the harness validation loop was added |
| `AGENT_PROVIDER=deepseek AGENT_MODEL=deepseek-v4-pro DEEPSEEK_API_KEY=... pnpm bench:tb:task -- --task-id regex-log` | PASS |

## Artifact

`pnpm package:agent-cli` created `.artifacts/agent-cli-linux-x64.tgz`.

The tarball contains:

- `agent-cli-linux-x64/bin/agent`
- `agent-cli-linux-x64/bin/node`
- `agent-cli-linux-x64/packages/agent-cli/dist/index.js`
- `agent-cli-linux-x64/node_modules/agent-ai/`
- `agent-cli-linux-x64/node_modules/agent-core/`

The bundled Node runtime came from `.artifacts/cache/node-v22.16.0-linux-x64.tar.xz`. If that cache file is absent, set `NODE_RUNTIME_TARBALL` to a pre-downloaded Linux Node tarball before running `pnpm package:agent-cli`.

## Container Startup

Docker validation used `debian:bookworm-slim`, which had no `node` on PATH. The artifact was extracted to `/opt/agent-cli`, `/opt/agent-cli/bin/agent` was linked to `/usr/local/bin/agent`, `command -v node` still failed, and `/usr/local/bin/agent --help` printed the CLI help successfully through the bundled runtime.

## Local Smoke Tasks

Fake-provider smoke passed all tasks through `runAgent` and the normal workspace tools:

| Task | Status |
| --- | --- |
| `create-file` | PASS |
| `edit-file` | PASS |
| `fix-test` | PASS |
| `inspect-and-summarize` | PASS |

Artifacts were written under `.artifacts/smoke-local/`.

## Harness Validation Loop

The Harbor adapter now supports a generic `agent run -> harness validation -> optional retry -> official verifier` loop for Terminal-Bench runs. It records `/app` manifests around each agent attempt, executes summary-declared `validation_commands`, falls back to syntax checks for changed `.py`, `.sh`, and `.js` files, and short-runs changed `check_*`, `verify_*`, `validate_*`, and `test_*` scripts. Failure feedback includes the validation command, exit code, stdout/stderr tails, related files, prior summary, and trace tail.

The report classifier now treats `max_wall_time_sec` as configuration text, not a timeout signal, and extracts verifier errors such as `ModuleNotFoundError: No module named 'cryptography'` as `missing_python_module:cryptography`.

## Known Limitations

- The generic harness validation loop has unit coverage but has not yet been re-run manually against `openssl-selfsigned-cert` or `regex-log` after this change.
- The package script intentionally does not download Node on demand. It uses `NODE_RUNTIME_TARBALL` or the documented `.artifacts/cache/` file and fails clearly when neither exists.
