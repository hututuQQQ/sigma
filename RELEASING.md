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

## Release-channel policy

A product SemVer without a prerelease suffix, including `0.1.0`, is a formal
stable release. A version with a suffix such as `-rc.1` is a prerelease. Linux
x64 is the stable Tier 1 release target for `0.1.0`. Windows x64 is published
as an explicitly labeled unsigned preview until the project has access to a
trusted Authenticode signing service. Both archives must pass the packaged
native sandbox, wrapper, live-provider, checksum, CycloneDX SBOM, and
signed-provenance gates.

The Windows preview gate additionally proves that the executables remain unsigned and
that every release gate other than the trusted Authenticode signer policy passed. The
Release notes, asset label, bundle README, and package metadata must all identify the
archive as a preview and warn that Windows SmartScreen or Smart App Control may warn or
block execution. Checksums, SBOMs, and signed provenance do not replace Authenticode.

When trusted signing becomes available, integrate the signing service in the
hosted workflow, require a timestamped signature from the approved identity,
and publish the first signed Windows archive under a new product version. Never
replace the unsigned assets of an existing immutable Release.

## Prepare a release

1. Update every workspace version, the native crate, `sigma-manifest.json`, and
   generated project facts to the same product SemVer. Serialized artifact
   schemas remain `1` and are not derived from the product version.
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

The tag workflow verifies that the tag exactly equals the root package version.
It then independently verifies the Linux x64 stable candidate and the Windows
x64 unsigned preview. If both jobs pass, it creates one GitHub Release with
both archives, checksums, SBOMs, signed provenance, and the public verification
key. A version without a prerelease suffix is published as the latest formal
release; a suffixed version is published as a prerelease.

Never replace assets on an existing release. If a published candidate is wrong,
publish a new version so checksums and provenance remain immutable.

## Reduced publication fallback

When hosted Actions or required platform verification is unavailable, a
maintainer may publish a source-only GitHub prerelease from a new annotated
prerelease tag on `main`. The release must not be marked latest, must not
include locally built portable archives, and must name the unavailable
publication gates. Resume binary publication with a new version after the
normal workflow passes; do not add binaries to the existing source-only
release later.

Do not bypass the dual-target workflow to attach locally built archives. If
either target release gate is unavailable, publish neither binary from that
tag; a source-only GitHub prerelease remains the only fallback.

## After publication

- Download every asset from GitHub and compare it with its `.sha256` sidecar.
- Confirm provenance verification succeeds with the published public key.
- Confirm the Linux archive is labeled stable and passes
  `agent doctor` plus a packaged-product smoke run on a clean machine.
- Confirm the Windows archive, package metadata, bundle README, and Release asset label all say unsigned preview, and confirm its executables have no Authenticode signer.
- For an unsuffixed version, confirm the GitHub Release is not a prerelease and
  is marked latest. For a suffixed version, confirm the inverse.
- Confirm both package metadata files report schema 1, the exact manifest
  product version, and the target-appropriate release channel.
