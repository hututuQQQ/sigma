import hashlib
import importlib
import sys
import types
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace


def install_harbor_codex_stubs() -> type:
    class Codex:
        def __init__(self, *args, logs_dir=None, version=None, **kwargs):
            self.logs_dir = Path(logs_dir or ".")
            self._version = version
            self.logger = SimpleNamespace(debug=lambda *_args, **_kwargs: None)
            self.installed = False

        async def _installed_codex_satisfies_version(self, _environment):
            return self.installed

        async def exec_as_root(self, environment, command):
            return await environment.exec(command, user="root")

        async def exec_as_agent(self, environment, command):
            return await environment.exec(command)

        def parse_version(self, stdout):
            return stdout.strip().removeprefix("codex-cli").strip()

    class BaseEnvironment:
        pass

    for name in (
        "harbor",
        "harbor.agents",
        "harbor.agents.installed",
        "harbor.environments",
    ):
        module = types.ModuleType(name)
        module.__path__ = []
        sys.modules[name] = module

    codex_module = types.ModuleType("harbor.agents.installed.codex")
    codex_module.Codex = Codex
    sys.modules["harbor.agents.installed.codex"] = codex_module

    environment_module = types.ModuleType("harbor.environments.base")
    environment_module.BaseEnvironment = BaseEnvironment
    sys.modules["harbor.environments.base"] = environment_module
    return Codex


def import_portable_codex_module():
    stub = install_harbor_codex_stubs()
    sys.modules.pop("portable.harbor.codex_harbor_agent", None)
    return importlib.import_module("portable.harbor.codex_harbor_agent"), stub


class RecordingEnvironment:
    def __init__(self, version_output="codex-cli 0.146.0"):
        self.version_output = version_output
        self.exec_calls = []
        self.uploads = []

    async def exec(self, command, **kwargs):
        self.exec_calls.append((command, kwargs))
        stdout = self.version_output if command == "codex --version" else ""
        return SimpleNamespace(return_code=0, stdout=stdout, stderr="")

    async def upload_file(self, source, target):
        self.uploads.append((Path(source), target))


class PortableCodexTest(unittest.IsolatedAsyncioTestCase):
    async def test_installs_verified_archive_without_live_runtime_downloads(self):
        module, stub = import_portable_codex_module()
        with TemporaryDirectory() as tmp:
            archive = Path(tmp) / "codex-cli.tgz"
            archive.write_bytes(b"immutable-runtime")
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            agent = module.PortableCodex(
                logs_dir=Path(tmp) / "logs",
                version="0.146.0",
                codex_cli_tarball=archive,
                codex_cli_sha256=digest,
            )
            environment = RecordingEnvironment()

            await agent.install(environment)

        self.assertIsInstance(agent, stub)
        self.assertEqual(
            environment.uploads,
            [(archive, "/tmp/codex-runtime/codex-cli.tgz")],
        )
        commands = "\n".join(command for command, _kwargs in environment.exec_calls)
        self.assertIn("tar -xzf", commands)
        self.assertIn("ln -sf /opt/codex-cli/bin/codex /usr/local/bin/codex", commands)
        self.assertIn("codex --version", commands)
        for forbidden in ("curl ", "npm ", "nvm ", "apt-get", "apk ", "yum "):
            self.assertNotIn(forbidden, commands)

    async def test_rejects_archive_digest_mismatch_before_upload(self):
        module, _stub = import_portable_codex_module()
        with TemporaryDirectory() as tmp:
            archive = Path(tmp) / "codex-cli.tgz"
            archive.write_bytes(b"runtime")
            with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
                module.PortableCodex(
                    logs_dir=Path(tmp) / "logs",
                    version="0.146.0",
                    codex_cli_tarball=archive,
                    codex_cli_sha256="0" * 64,
                )

    async def test_rejects_extracted_version_mismatch(self):
        module, _stub = import_portable_codex_module()
        with TemporaryDirectory() as tmp:
            archive = Path(tmp) / "codex-cli.tgz"
            archive.write_bytes(b"runtime")
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            agent = module.PortableCodex(
                logs_dir=Path(tmp) / "logs",
                version="0.146.0",
                codex_cli_tarball=archive,
                codex_cli_sha256=digest,
            )
            with self.assertRaisesRegex(RuntimeError, "version mismatch"):
                await agent.install(RecordingEnvironment("codex-cli 0.145.0"))

    async def test_preserves_stock_fast_path_when_exact_version_is_present(self):
        module, _stub = import_portable_codex_module()
        with TemporaryDirectory() as tmp:
            archive = Path(tmp) / "codex-cli.tgz"
            archive.write_bytes(b"runtime")
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            agent = module.PortableCodex(
                logs_dir=Path(tmp) / "logs",
                version="0.146.0",
                codex_cli_tarball=archive,
                codex_cli_sha256=digest,
            )
            agent.installed = True
            environment = RecordingEnvironment()

            await agent.install(environment)

        self.assertEqual(environment.uploads, [])
        self.assertEqual(environment.exec_calls, [])


if __name__ == "__main__":
    unittest.main()
