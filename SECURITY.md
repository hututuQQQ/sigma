# Security Policy

## Supported versions

Security fixes are provided for the newest published release only. Release
candidates may receive fixes without a backport to an older candidate.

| Version | Supported |
| --- | --- |
| Latest `3.x` release or release candidate | Yes |
| Older versions | No |

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

Official portable product archives are created only by the repository's GitHub
Actions release workflow. Each archive is accompanied by a SHA-256 checksum,
CycloneDX SBOM, signed provenance statement, and the public provenance verification
key. Windows release executables are additionally Authenticode-signed and timestamped.

A GitHub prerelease may be source-only when hosted Actions or trusted signing is
unavailable. Such a prerelease does not contain official portable product archives
and must state which publication gates remain unavailable.

An explicitly labeled unsigned preview prerelease may attach a portable archive for
evaluation. It is not an official signed product archive, must not be marked latest,
and must include a matching SHA-256 sidecar and CycloneDX SBOM while disclosing that
Authenticode and trusted provenance gates did not pass.

Treat locally built archives, workflow artifacts, and files without matching release
sidecars as development outputs rather than official releases.

## Runtime capability defaults

Configuration schema v4 keeps `sandbox=required` and workspace-only writes, but
defaults declared read access to `read_scope=host`, sandbox networking to
`network=full`, and Linux process transfer to `process_handoff=allow`. External
reads, network access, and handoff are sensitive per-call effects: `ask` requires
confirmation for each call, `auto` issues a fresh call-bound grant, and `deny`
rejects them. These settings never authorize unsafe host execution.

Use the following configuration for the strict capability posture:

```toml
schema_version = 4

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
