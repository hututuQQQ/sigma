# Releasing Sigma Code

Only maintainers with access to the protected release environment should publish an
official release. A Git tag alone is not a release: the GitHub Actions workflow must
complete every platform, security, live-product, and artifact-verification gate before
it creates the GitHub Release.

## Required repository configuration

Configure these GitHub Actions secrets:

- `DEEPSEEK_API_KEY`
- `AGENT_RELEASE_SIGNING_PRIVATE_KEY_PEM`
- `AGENT_RELEASE_TRUSTED_PUBLIC_KEY_PEM`

The public provenance key must match the private signing key. Keep the private key out
of the repository and all workflow artifacts.

## Code signing policy

Linux x64 is the official stable binary release. Windows x64 is published in the same
GitHub Release as an explicitly labeled unsigned preview until the project has access
to a trusted Authenticode signing service. Both archives must pass the packaged native
sandbox, wrapper, live-provider, checksum, CycloneDX SBOM, and signed-provenance gates.

The Windows preview gate additionally proves that the executables remain unsigned and
that every release gate other than the trusted Authenticode signer policy passed. The
Release notes, asset label, bundle README, and package metadata must all identify the
archive as a preview and warn that Windows SmartScreen or Smart App Control may warn or
block execution. Checksums, SBOMs, and signed provenance do not replace Authenticode.

When trusted signing becomes available, integrate the signing service in the hosted
workflow, require a timestamped signature from the approved identity, and publish the
first signed Windows archive under a new patch version. Never replace the unsigned
preview assets of an existing immutable Release.

## Prepare a release

1. Update every workspace version, the native crate, `sigma-manifest.json`, generated
   project facts, and `CHANGELOG.md` to the same SemVer value.
2. Run `pnpm generate:manifest` and commit the generated facts.
3. Run the normal product gates locally and review the exact staged diff.
4. Merge through a pull request and require a green CI run on the release commit.
5. In GitHub Actions, manually run **Release verification and publication** on `main`.
   This is a dry run: it builds and verifies candidates but does not publish them.

## Publish

Create and push an annotated tag only after the dry run succeeds:

```powershell
$Version = (Get-Content package.json -Raw | ConvertFrom-Json).version
git tag -a "v$Version" -m "Sigma Code v$Version"
git push origin "v$Version"
```

The tag workflow verifies that the tag exactly equals the root package version. It
then independently verifies the Linux x64 stable candidate and the Windows x64
unsigned preview. If both jobs pass, it creates one GitHub Release with both archives,
checksums, SBOMs, signed provenance, and the public verification key. The Release notes
and asset labels distinguish the two channels. Pre-release SemVer versions are marked
as GitHub prereleases; stable versions are marked latest because Linux is stable.

Never replace assets on an existing release. If a published candidate is wrong,
publish a new version so checksums and provenance remain immutable.

## Reduced publication fallback

When hosted Actions or trusted platform signing is unavailable, a maintainer may
publish a source-only GitHub prerelease from an annotated tag on `main`. The release
must not be marked latest, must not include locally built portable archives, and must
name the unavailable publication gates. Resume binary publication with a new version
after the normal workflow passes; do not add binaries to the existing source-only
release later.

Do not bypass the dual-track workflow to attach locally built archives. If the Windows
preview gate is unavailable, publish neither binary from that tag; use a new version
after the workflow is healthy. If the stable Linux gate is unavailable, a source-only
GitHub prerelease remains the only fallback and must not be marked latest.

## After publication

- Download every asset from GitHub and compare it with its `.sha256` sidecar.
- Confirm provenance verification succeeds with the published public key.
- Confirm the Linux archive is labeled stable and passes `agent doctor` plus a packaged-product smoke run on a clean machine.
- Confirm the Windows archive, package metadata, bundle README, and Release asset label all say unsigned preview, and confirm its executables have no Authenticode signer.
- Move the changelog entries into the released version and open the next
  `[Unreleased]` section.
