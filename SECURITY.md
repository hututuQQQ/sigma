# Security Policy

## Supported versions

Security fixes are provided for the current release baseline only. The project
does not maintain compatibility or security backports for superseded releases
or preview formats.

| Version | Supported |
| --- | --- |
| Current `0.1.x` Linux stable release | Yes |
| Current `0.1.x` Windows unsigned preview | Yes, with preview limitations |
| Superseded releases, previews, and other schemas | No |

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use
[GitHub private vulnerability reporting](https://github.com/hututuQQQ/sigma/security/advisories/new)
and include:

- the affected version, operating system, and architecture;
- a minimal reproduction or proof of concept;
- the security impact and any known preconditions; and
- whether the issue is already public or under active exploitation.

You should receive an acknowledgement within seven days. We will coordinate a
fix and disclosure timeline after reproducing and assessing the report. If GitHub
private vulnerability reporting is unavailable, do not publish exploit details;
open a minimal issue asking the maintainer to enable a private contact path.

## Release verification

Portable product archives are official release artifacts only when created by
the repository's GitHub Actions release workflow. Each archive is accompanied
by a SHA-256 checksum, CycloneDX SBOM, signed provenance statement, and the
public provenance verification key. For `0.1.5`, Linux x64 is stable and
Windows x64 is an unsigned preview.

The Sigma Code Windows installer published by that workflow is also an official
release artifact. It bundles the verified Windows Runtime from the same release
and includes a SHA-256 sidecar, blockmap, and Sigma-owned update manifest. The
installer remains an unsigned preview and does not have a trusted Authenticode
signature.

Windows x64 is an explicitly labeled unsigned preview until trusted
Authenticode signing is available. Its package, sandbox, wrapper, live-provider,
checksum, SBOM, and signed-provenance gates must pass, but Windows SmartScreen
or Smart App Control may warn or block it.

A GitHub prerelease may be source-only when hosted Actions or trusted signing is
unavailable. Such a prerelease does not contain official portable product archives
and must state which publication gates remain unavailable.

An unsuffixed product SemVer is a formal Release and may be marked latest; a
version with a prerelease suffix must be published as a prerelease. Release
notes, asset labels, bundle READMEs, and package metadata must disclose each
target's release channel. Trusted provenance is mandatory; an explicitly
unsigned Windows candidate may leave only the Authenticode signer policy
unsatisfied.

Treat locally built archives, workflow artifacts, and files without matching release
sidecars as development outputs rather than official releases.

## Runtime capability defaults

Configuration schema 1 defaults to `permission_mode=workspace-auto`,
`sandbox=required`, `read_scope=workspace`, `network=full`, and
`process_handoff=allow`. Workspace-scoped reads and declared writes are
automatic; external reads, full-network calls, and repository metadata writes
remain separately authorized. No setting enables unsafe host execution.

Use the following configuration for the strict capability posture:

```toml
schema_version = 1

[security]
sandbox = "required"
read_scope = "workspace"
network = "none"
process_handoff = "deny"
```

Process handoff is currently advertised only on Linux when the native sandbox and
watchdog self-tests pass. Windows and other platforms fail closed. A handed-off
service is intentionally no longer owned or terminated by its Sigma session, so
only independently health-checked deliverables should use this capability.

Every Sigma-owned persisted artifact uses schema 1. An unknown schema, another
store layout, or an old checkpoint journal is rejected without modifying the
input. There is no migration or downgrade path; preserve incompatible data
outside the active state directory if it must be retained for manual audit.
