# Contributing to Sigma Code

Thank you for helping improve Sigma Code.

## Before opening a change

- For a bug, first search existing issues and include a minimal reproduction.
- For a substantial feature or architecture change, open an issue before investing
  in an implementation.
- Report vulnerabilities through the private process in [SECURITY.md](SECURITY.md),
  not through a public issue or pull request.
- Follow every applicable `AGENTS.md`, including the benchmark-fairness rules.

## Development setup

Sigma pins Node.js `26.4.0`, pnpm `11.7.0`, Rust `1.96.0`, and Python `3.12`.

```powershell
corepack enable
corepack prepare pnpm@11.7.0 --activate
pnpm install --frozen-lockfile
pnpm build
```

Run the normal local gate before submitting a pull request:

```powershell
pnpm lint
pnpm test:coverage
cargo test --locked --manifest-path native/sigma-exec/Cargo.toml
cargo clippy --locked --manifest-path native/sigma-exec/Cargo.toml --all-targets -- -D warnings
python -m unittest tests.test_harbor_agent
```

Some release and package tests require Docker, platform sandbox support, signing
credentials, or a live DeepSeek credential. The pull request should state which
checks were run and which environment-dependent checks remain for CI.

## Pull requests

- Keep each pull request focused and explain the product behavior it changes.
- Add or update tests for observable behavior.
- Preserve fail-closed security behavior and durable protocol compatibility.
- Do not include generated packages, local artifacts, credentials, or benchmark-
  specific shortcuts.
- Update public documentation and `CHANGELOG.md` for user-visible changes.

By contributing, you agree that your contribution is licensed under the MIT License.
