# Changelog

All notable changes to Sigma Code are documented in this file. The project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html), and this changelog follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- Configuration schema v4 defaults to host-scoped declared reads, full sandbox networking, and explicit process handoff while retaining required isolation and workspace-only writes.
- Sealed no-op checkpoints no longer advance the mutation frontier; mutating validation binds to the post-seal frontier.
- Workspace write-plan checks no longer follow a final symlink object, while linked ancestors and external-target writes remain denied.

### Added

- Stable external-input reads with per-call approval, `input_access` evidence, and unresolved goal-input completion obligations.
- Linux deliverable process handoff with detached stdio, watchdog revocation, durable lifecycle events, and fail-closed capability discovery on unsupported platforms.

### Security

- External reads and handoff are sensitive effects with fresh per-call grants; unsafe host execution and workspace-external writes remain disabled.
- The strict pre-v4 posture remains available with `read_scope=workspace`, `network=none`, and `process_handoff=deny`.

## [4.0.0-rc.1] - 2026-07-17

### Changed

- Completion and validation now converge on a runtime-owned mutation frontier instead of model-selected evidence IDs.
- Review policy is now `off`, `advisory`, or `required`; the standard profile uses advisory review and the strict profile requires it.
- Oversized tool exchanges are retained losslessly or replaced atomically by plain text during context compaction.

### Added

- A structured, local-only `git_transaction` tool with CAS-backed repository metadata rollback.
- Typed `report_blocked` recovery outcomes and `repository_delta` evidence.

### Removed

- V3 completion criteria arguments and `review_non_documentation_changes` profile configuration.

## [3.0.0-rc.2] - 2026-07-16

### Added

- A directly usable Windows x64 portable CLI preview archive.
- SHA-256, CycloneDX SBOM, and provenance sidecars for the preview archive.

### Security

- The preview archive is explicitly unsigned: Windows Authenticode signer policy and
  trusted provenance signature gates are not satisfied.
- The development-only `qs` dependency is constrained to patched version `6.15.2`.
- Users should verify the published SHA-256 sidecar before extracting the archive and
  should expect Windows SmartScreen to warn.

This prerelease is intended for hands-on evaluation while hosted Actions and trusted
Windows code signing remain unavailable. It is not the stable or signed release.

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

[Unreleased]: https://github.com/hututuQQQ/sigma/compare/v4.0.0-rc.1...HEAD
[4.0.0-rc.1]: https://github.com/hututuQQQ/sigma/releases/tag/v4.0.0-rc.1
[3.0.0-rc.2]: https://github.com/hututuQQQ/sigma/releases/tag/v3.0.0-rc.2
[3.0.0-rc.1]: https://github.com/hututuQQQ/sigma/releases/tag/v3.0.0-rc.1
