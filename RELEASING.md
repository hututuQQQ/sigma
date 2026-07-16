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
- `AGENT_WINDOWS_SIGN_CERTIFICATE_PFX_BASE64`
- `AGENT_WINDOWS_SIGN_CERTIFICATE_PASSWORD`

Configure `AGENT_WINDOWS_SIGN_TIMESTAMP_URL` as a repository variable. The public
provenance key must match the private signing key. Keep the private key and PFX out of
the repository and all workflow artifacts.

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
then independently builds and verifies Windows x64 and Linux x64 candidates. If both
jobs pass, it creates the GitHub Release with the archives, checksums, SBOMs, signed
provenance, and public verification key. Pre-release SemVer versions are marked as
GitHub prereleases; stable versions are marked latest.

Never replace assets on an existing release. If a published candidate is wrong,
publish a new version so checksums and provenance remain immutable.

## Source-only prerelease fallback

When hosted Actions or trusted platform signing is unavailable, a maintainer may
publish a source-only GitHub prerelease from an annotated tag on `main`. The release
must not be marked latest, must not include locally built portable archives, and must
name the unavailable publication gates. Resume binary publication with a new version
after the normal workflow passes; do not add binaries to the existing source-only
release later.

## After publication

- Download every asset from GitHub and compare it with its `.sha256` sidecar.
- Confirm the Windows executable has a valid timestamped Authenticode signature.
- Confirm provenance verification succeeds with the published public key.
- Exercise `agent doctor` and a packaged-product smoke run on a clean machine.
- Move the changelog entries into the released version and open the next
  `[Unreleased]` section.
