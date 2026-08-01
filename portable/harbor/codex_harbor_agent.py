"""Portable, offline installer for Harbor's stock Codex CLI agent.

The class deliberately inherits Harbor's Codex execution, prompt, auth, timeout,
and trajectory behavior.  Only runtime installation changes: a caller supplies
one immutable host archive, which is uploaded and verified before Codex runs.
"""

from __future__ import annotations

import hashlib
import pathlib
import re
import shlex
from typing import Any

from harbor.agents.installed.codex import Codex
from harbor.environments.base import BaseEnvironment


_SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")


def _sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class PortableCodex(Codex):
    """Run Harbor's Codex adapter with a pre-resolved native CLI archive."""

    _REMOTE_ARCHIVE = "/tmp/codex-runtime/codex-cli.tgz"
    _REMOTE_ROOT = "/opt/codex-cli"

    def __init__(
        self,
        *args: Any,
        codex_cli_tarball: pathlib.Path | str | None = None,
        codex_cli_sha256: str | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(*args, **kwargs)
        if codex_cli_tarball is None:
            raise ValueError("codex_cli_tarball is required")
        runtime_path = pathlib.Path(codex_cli_tarball)
        if not runtime_path.is_absolute():
            raise ValueError("codex_cli_tarball must be an absolute path")
        if not runtime_path.is_file():
            raise ValueError(f"codex_cli_tarball is missing: {runtime_path}")

        expected_sha256 = str(codex_cli_sha256 or "").strip().lower()
        if not _SHA256_PATTERN.fullmatch(expected_sha256):
            raise ValueError("codex_cli_sha256 must be a lowercase SHA-256 digest")
        actual_sha256 = _sha256_file(runtime_path)
        if actual_sha256 != expected_sha256:
            raise ValueError(
                "codex_cli_tarball SHA-256 mismatch: "
                f"expected {expected_sha256}, got {actual_sha256}"
            )

        self.codex_cli_tarball = runtime_path
        self.codex_cli_sha256 = expected_sha256

    async def install(self, environment: BaseEnvironment) -> None:
        # A matching version string is not a content identity. Re-check the
        # caller's archive immediately before every upload and always replace
        # any preinstalled binary with that pinned artifact.
        actual_sha256 = _sha256_file(self.codex_cli_tarball)
        if actual_sha256 != self.codex_cli_sha256:
            raise RuntimeError(
                "codex_cli_tarball changed after initialization: "
                f"expected {self.codex_cli_sha256}, got {actual_sha256}"
            )

        await self.exec_as_root(
            environment,
            command="mkdir -p /tmp/codex-runtime",
        )
        await environment.upload_file(self.codex_cli_tarball, self._REMOTE_ARCHIVE)
        remote_root = shlex.quote(self._REMOTE_ROOT)
        remote_archive = shlex.quote(self._REMOTE_ARCHIVE)
        await self.exec_as_root(
            environment,
            command=(
                "set -eu; "
                f"if ! printf '%s  %s\\n' {shlex.quote(self.codex_cli_sha256)} "
                f"{remote_archive} | sha256sum -c -; then "
                f"rm -f {remote_archive}; exit 1; fi; "
                f"rm -rf {remote_root}; "
                f"mkdir -p {remote_root} /usr/local/bin; "
                f"tar -xzf {remote_archive} -C {remote_root} --strip-components=1; "
                f"test -x {remote_root}/bin/codex; "
                f"chmod 0755 {remote_root}/bin/codex; "
                f"ln -sf {remote_root}/bin/codex /usr/local/bin/codex; "
                f"if test -f {remote_root}/bin/rg; then "
                f"chmod 0755 {remote_root}/bin/rg; "
                f"ln -sf {remote_root}/bin/rg /usr/local/bin/rg; "
                "fi; "
                f"rm -f {remote_archive}"
            ),
        )

        version_result = await self.exec_as_agent(
            environment,
            command="codex --version",
        )
        installed_version = self.parse_version(version_result.stdout or "")
        if self._version is not None and installed_version != self._version:
            raise RuntimeError(
                "Portable Codex version mismatch: "
                f"expected {self._version}, got {installed_version or 'unknown'}"
            )
