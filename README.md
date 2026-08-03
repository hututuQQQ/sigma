<p align="center">
  <img src="assets/sigma-code-mark.png" alt="Sigma Code logo" width="170">
</p>

<h1 align="center">Sigma Code</h1>

<p align="center">
  The open-source coding agent that survives interruptions and proves its changes.<br>
  Run long coding tasks in a native sandbox, resume anytime, and finish with evidence.
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/hututuQQQ/sigma/releases/tag/v0.1.5"><img alt="Status: 0.1.5 stable release" src="https://img.shields.io/badge/status-0.1.5%20stable-2ea44f"></a>
  <img alt="Release targets: Linux stable and Windows unsigned preview" src="https://img.shields.io/badge/release%20targets-Linux%20stable%20%2B%20Windows%20unsigned%20preview-0078d4">
  <img alt="Formal evaluation: preregistered" src="https://img.shields.io/badge/formal%20evaluation-preregistered-4cc9c0">
</p>

<p align="center">
  <a href="https://sigmacode.biz"><strong>Official website</strong></a>
  · <a href="https://sigmacode.biz/en/docs/getting-started"><strong>Documentation</strong></a>
  · <a href="https://github.com/hututuQQQ/sigma/releases/tag/v0.1.5"><strong>Download v0.1.5</strong></a>
  · <a href="SECURITY.md">Security</a>
</p>

<p align="center">
  <img src="assets/sigma-code-desktop.png" alt="Sigma Code desktop app using Sigma Runtime to analyze a repository" width="1200">
</p>

Sigma Code is built for coding tasks that must not lose their state or declare victory too early. Commands run inside a required native sandbox, the complete working session is persisted for recovery, and changed work completes only after current validation and any required review agree.

This repository owns Sigma Runtime, the CLI, the TUI, and the ACP v1 server. The independently maintained [Sigma Code desktop, Web, and mobile client](https://github.com/hututuQQQ/sigma-code) is a downstream of [T3 Code](https://github.com/pingdotgg/t3code) and connects to this runtime over ACP v1.

> [!IMPORTANT]
> **0.1.5 is the current supported baseline.** Linux x64 is stable. Windows x64 is an unsigned preview and may trigger Windows security warnings. Verify the published SHA-256 sidecar and signed provenance before installation.

## Why Sigma Code

| Capability | What it means |
| --- | --- |
| Native sandbox execution | Commands stay inside required OS-level isolation. If the sandbox is unhealthy, Sigma refuses to execute. |
| Durable sessions | Plans, model turns, tool receipts, checkpoints, and outcomes survive a closed terminal or restarted process. |
| Evidence-backed completion | Model prose cannot close changed work without current validation and any required review evidence. |
| One runtime, multiple surfaces | The desktop client, TUI, one-shot CLI, and automation use the same event-sourced runtime. |

## Get started

### Desktop on Windows

Download `Sigma-Code-0.1.5-x64.exe` from the [v0.1.5 release](https://github.com/hututuQQQ/sigma/releases/tag/v0.1.5). The installer bundles the desktop UI and verified Sigma Runtime; a separate Node.js or Agent CLI install is not required.

Windows artifacts are currently unsigned previews. Review the warning and verification steps in the [installation guide](https://sigmacode.biz/en/docs/getting-started) before running them.

### CLI and TUI on Linux

Download and verify the Linux x64 release archive, then initialize a repository:

```sh
SIGMA="$HOME/.local/share/sigma-code"
WORKSPACE="/path/to/your/repository"

export DEEPSEEK_API_KEY="your-api-key"

"$SIGMA/bin/agent" init --workspace "$WORKSPACE" --provider deepseek
"$SIGMA/bin/agent" doctor --workspace "$WORKSPACE" --check-api
"$SIGMA/bin/agent" tui --workspace "$WORKSPACE"
```

Keep secrets out of `.agent/config.toml` and source control. For the Windows terminal archive, other providers, permissions, session commands, and reasoning levels, use the [CLI and configuration reference](https://sigmacode.biz/en/docs/cli-and-configuration).

## What it can do

- Work through the desktop client, a CJK/IME-aware TUI, one-shot `run`, or read-only `inspect`.
- Resume, replay, steer, cancel, and audit durable sessions after process interruption.
- Read and edit repositories, run commands, use LSP-backed code intelligence, and connect explicitly trusted MCP servers.
- Execute inside native Windows AppContainer or Linux namespace isolation with declared file, process, and network effects.
- Coordinate bounded child agents with explicit writer isolation and integration.
- Track tests, validation, reviews, workspace deltas, and checkpoints in one typed evidence ledger.
- Connect multiple model providers through the version-pinned Pi gateway, including the experimental ChatGPT/Codex subscription route.

## Documentation

The complete product and technical documentation lives on the website:

| Guide | Covers |
| --- | --- |
| [Getting started](https://sigmacode.biz/en/docs/getting-started) | Releases, verification, Linux and Windows setup, first task |
| [CLI, configuration, and providers](https://sigmacode.biz/en/docs/cli-and-configuration) | Commands, TUI controls, permissions, authentication, reasoning levels |
| [Runtime architecture](https://sigmacode.biz/en/docs/architecture) | Composition root, event loop, package boundaries, ACP v1 |
| [Security, permissions, and recovery](https://sigmacode.biz/en/docs/security-and-recovery) | Native sandbox, path and network boundaries, durable state, completion |
| [Durable sessions](https://sigmacode.biz/en/features/durable-sessions) | Event streams, checkpoints, replay, and resume |
| [Native sandboxing](https://sigmacode.biz/en/features/native-sandbox) | Windows AppContainer and Linux namespaces |
| [Evidence-backed completion](https://sigmacode.biz/en/features/evidence-backed-completion) | Validation, review, and current-state evidence |
| [Evaluation method](https://sigmacode.biz/en/docs/evaluation) | Preregistration, fairness boundary, results, and limitations |

Repository-maintainer material remains close to the code:

- [CONTRIBUTING.md](CONTRIBUTING.md) — development workflow and contribution expectations
- [VALIDATION.md](VALIDATION.md) — test layers, coverage, native checks, and release evidence
- [RELEASING.md](RELEASING.md) — packaging and release procedure
- [SECURITY.md](SECURITY.md) — supported versions, trust boundary, and vulnerability reporting

## Transparent evaluation

A staged Terminal-Bench 2.1 diagnostic on July 27–28, 2026 used DeepSeek `deepseek-v4-pro`, the same 89-task population, one Sigma attempt per task, zero retries, and no verifier feedback. Sigma Code completed **51/89 (57.303%)**; OpenCode completed **49/89 (55.056%)**.

This is a mixed-source engineering diagnostic, not a universal-superiority claim or a single score for the final source head. Read the [method, fairness rules, and limitations](https://sigmacode.biz/en/docs/evaluation) before comparing the numbers.

## Develop

The repository pins Node.js `26.4.0`, pnpm `11.7.0`, and Rust `1.96.0`.

```powershell
corepack enable
corepack prepare pnpm@11.7.0 --activate
pnpm install --frozen-lockfile
pnpm build
pnpm lint
pnpm test:coverage
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [VALIDATION.md](VALIDATION.md) before changing runtime, sandbox, persistence, or evaluation behavior.

## License

Sigma Code is available under the [MIT License](LICENSE).
