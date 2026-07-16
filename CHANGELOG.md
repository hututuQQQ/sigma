# Changelog

All notable changes to Sigma Code are documented in this file. The project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html), and this changelog follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- Nothing yet.

## [3.0.0-rc.1] - 2026-07-16

### Added

- A durable event-sourced coding-agent runtime shared by the CLI and TUI.
- Fail-closed native process containment for Windows x64 and Linux x64.
- Typed tool effects, approvals, checkpoints, evidence, review, and completion.
- Portable Windows x64 and Linux x64 packaging support with checksums, CycloneDX
  SBOMs, signed provenance, and archive verification.
- DeepSeek gateway support and an experimental GLM/Z.ai gateway path.
- Session replay, recovery, follow-up queues, and supervised sub-agent execution.

### Security

- Windows release executables must be Authenticode-signed and timestamped.
- Release provenance must be signed by the configured project key.
- Packaging and release verification fail closed when required signing material,
  sandbox guarantees, or evidence is missing.

This source-only release candidate is intended for public validation before the
first stable `3.0.0` release. No portable binary archives are attached because the
trusted Windows code-signing gate is not yet configured. Windows x64 remains the
first intended end-user binary target; Linux x64 packaging remains a technical
preview and CI validation target.

[Unreleased]: https://github.com/hututuQQQ/sigma/compare/v3.0.0-rc.1...HEAD
[3.0.0-rc.1]: https://github.com/hututuQQQ/sigma/releases/tag/v3.0.0-rc.1
