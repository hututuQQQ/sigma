import importlib
import os
import sys
import types
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import AsyncMock


def install_harbor_stubs() -> None:
    class BaseAgent:
        def __init__(self, logs_dir, model_name=None, extra_env=None, **_kwargs):
            self.logs_dir = Path(logs_dir)
            self.model_name = model_name
            self._extra_env = dict(extra_env or {})

        @property
        def extra_env(self):
            return dict(self._extra_env)

    class BaseEnvironment:
        pass

    class AgentContext(SimpleNamespace):
        pass

    module_names = [
        "harbor",
        "harbor.agents",
        "harbor.environments",
        "harbor.models",
        "harbor.models.agent",
    ]
    for name in module_names:
        module = types.ModuleType(name)
        module.__path__ = []
        sys.modules[name] = module

    agents_base = types.ModuleType("harbor.agents.base")
    agents_base.BaseAgent = BaseAgent
    sys.modules["harbor.agents.base"] = agents_base

    environments_base = types.ModuleType("harbor.environments.base")
    environments_base.BaseEnvironment = BaseEnvironment
    sys.modules["harbor.environments.base"] = environments_base

    context_module = types.ModuleType("harbor.models.agent.context")
    context_module.AgentContext = AgentContext
    sys.modules["harbor.models.agent.context"] = context_module


def import_agent_module():
    install_harbor_stubs()
    sys.modules.pop("integrations.harbor.agent", None)
    return importlib.import_module("integrations.harbor.agent")


class HarborAgentTest(unittest.IsolatedAsyncioTestCase):
    async def test_model_name_is_used_unless_model_is_explicit(self):
        module = import_agent_module()

        self.assertEqual(module.AgentCliHarborAgent(model_name="custom-model").model, "custom-model")
        self.assertEqual(
            module.AgentCliHarborAgent(model="explicit-model", model_name="custom-model").model,
            "explicit-model",
        )
        self.assertEqual(module.AgentCliHarborAgent(provider="deepseek").model, "deepseek-v4-pro")
        self.assertEqual(module.AgentCliHarborAgent(provider="glm").model, "glm-5.2")

    async def test_setup_prefers_uploaded_tarball(self):
        module = import_agent_module()
        with TemporaryDirectory() as tmp:
            tarball = Path(tmp) / "agent-cli-linux.tgz"
            tarball.write_bytes(b"fake")
            old_tarball = os.environ.get("AGENT_CLI_TARBALL")
            old_cli_dir = os.environ.get("AGENT_CLI_DIR")
            os.environ["AGENT_CLI_TARBALL"] = str(tarball)
            os.environ.pop("AGENT_CLI_DIR", None)
            try:
                env = SimpleNamespace(
                    exec=AsyncMock(
                        side_effect=[
                            SimpleNamespace(return_code=0),
                            SimpleNamespace(return_code=1),
                            SimpleNamespace(return_code=0),
                            SimpleNamespace(return_code=0),
                            SimpleNamespace(return_code=0),
                        ]
                    ),
                    upload_file=AsyncMock(),
                    upload_dir=AsyncMock(),
                    download_file=AsyncMock(),
                )
                agent = module.AgentCliHarborAgent(logs_dir=Path(tmp) / "logs")

                await agent.setup(env)

                env.upload_file.assert_awaited_once_with(tarball, "/tmp/agent/agent-cli.tgz")
                env.upload_dir.assert_not_called()
                self.assertEqual(env.exec.await_count, 5)
                commands = [call.args[0] for call in env.exec.await_args_list]
                self.assertIn("command -v node >/dev/null", commands)
                self.assertIn("/usr/local/bin/agent --help", commands)
            finally:
                if old_tarball is None:
                    os.environ.pop("AGENT_CLI_TARBALL", None)
                else:
                    os.environ["AGENT_CLI_TARBALL"] = old_tarball
                if old_cli_dir is None:
                    os.environ.pop("AGENT_CLI_DIR", None)
                else:
                    os.environ["AGENT_CLI_DIR"] = old_cli_dir

    async def test_setup_checks_existing_agent_help(self):
        module = import_agent_module()
        with TemporaryDirectory() as tmp:
            env = SimpleNamespace(
                exec=AsyncMock(
                    side_effect=[
                        SimpleNamespace(return_code=0),
                        SimpleNamespace(return_code=0),
                        SimpleNamespace(return_code=0),
                        SimpleNamespace(return_code=0),
                    ]
                ),
                upload_file=AsyncMock(),
                upload_dir=AsyncMock(),
                download_file=AsyncMock(),
            )
            agent = module.AgentCliHarborAgent(logs_dir=Path(tmp) / "logs")

            await agent.setup(env)

            commands = [call.args[0] for call in env.exec.await_args_list]
            self.assertEqual(
                commands,
                [
                    "mkdir -p /tmp/agent",
                    "command -v /usr/local/bin/agent >/dev/null 2>&1",
                    "command -v node >/dev/null",
                    "/usr/local/bin/agent --help",
                ],
            )

    async def test_setup_fails_clearly_when_node_is_missing(self):
        module = import_agent_module()
        with TemporaryDirectory() as tmp:
            env = SimpleNamespace(
                exec=AsyncMock(
                    side_effect=[
                        SimpleNamespace(return_code=0),
                        SimpleNamespace(return_code=0),
                        SimpleNamespace(return_code=1, stderr="node missing"),
                    ]
                ),
                upload_file=AsyncMock(),
                upload_dir=AsyncMock(),
                download_file=AsyncMock(),
            )
            agent = module.AgentCliHarborAgent(logs_dir=Path(tmp) / "logs")

            with self.assertRaisesRegex(RuntimeError, "Node is required"):
                await agent.setup(env)

            commands = [call.args[0] for call in env.exec.await_args_list]
            self.assertNotIn("/usr/local/bin/agent --help", commands)

    async def test_run_uses_async_signature_downloads_logs_and_populates_context(self):
        module = import_agent_module()
        with TemporaryDirectory() as tmp:
            logs_dir = Path(tmp) / "logs"
            exec_commands = []

            async def exec_side_effect(command, **kwargs):
                exec_commands.append((command, kwargs))
                return SimpleNamespace(return_code=0, stdout="", stderr="")

            async def download_side_effect(source_path, target_path):
                target = Path(target_path)
                target.parent.mkdir(parents=True, exist_ok=True)
                if source_path.endswith("summary.json"):
                    target.write_text(
                        """{
  "commands_executed": 7,
  "input_tokens": 11,
  "output_tokens": 13,
  "cache_tokens": 2,
  "cost_usd": 0.123,
  "last_error": null
}
""",
                        encoding="utf-8",
                    )
                else:
                    target.write_text('{"type":"run_end"}\n', encoding="utf-8")

            env = SimpleNamespace(
                exec=AsyncMock(side_effect=exec_side_effect),
                upload_file=AsyncMock(),
                upload_dir=AsyncMock(),
                download_file=AsyncMock(side_effect=download_side_effect),
            )
            context = SimpleNamespace()
            agent = module.AgentCliHarborAgent(logs_dir=logs_dir)

            await agent.run("fix the task", env, context)

            env.upload_file.assert_awaited()
            self.assertEqual(env.upload_file.await_args.args[1], "/tmp/agent/instruction.md")
            main_commands = [item for item in exec_commands if "/usr/local/bin/agent solve" in item[0]]
            self.assertEqual(len(main_commands), 1)
            command, kwargs = main_commands[0]
            self.assertIn("--max-turns 200", command)
            self.assertIn("--command-timeout-sec 180", command)
            self.assertIn("--max-wall-time-sec 7200", command)
            self.assertEqual(kwargs["timeout_sec"], 7260)
            env.download_file.assert_any_await("/tmp/agent/summary.json", logs_dir / "summary.json")
            env.download_file.assert_any_await("/tmp/agent/trace.jsonl", logs_dir / "trace.jsonl")

            self.assertEqual(context.exit_code, 0)
            self.assertIsNone(context.error_message)
            self.assertEqual(context.commands_executed, 7)
            self.assertEqual(context.n_input_tokens, 11)
            self.assertEqual(context.n_output_tokens, 13)
            self.assertEqual(context.n_cache_tokens, 2)
            self.assertEqual(context.cost_usd, 0.123)


if __name__ == "__main__":
    unittest.main()
