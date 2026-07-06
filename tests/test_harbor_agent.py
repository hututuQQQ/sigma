import importlib
import json
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
            tarball = Path(tmp) / "agent-cli-linux-x64.tgz"
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
                self.assertEqual(env.exec.await_count, 4)
                commands = [call.args[0] for call in env.exec.await_args_list]
                self.assertFalse(any("command -v node" in command for command in commands))
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
                    "/usr/local/bin/agent --help",
                ],
            )

    async def test_setup_help_failure_includes_stdout_and_stderr(self):
        module = import_agent_module()
        with TemporaryDirectory() as tmp:
            env = SimpleNamespace(
                exec=AsyncMock(
                    side_effect=[
                        SimpleNamespace(return_code=0),
                        SimpleNamespace(return_code=0),
                        SimpleNamespace(return_code=2, stdout="usage blew up", stderr="missing runtime"),
                    ]
                ),
                upload_file=AsyncMock(),
                upload_dir=AsyncMock(),
                download_file=AsyncMock(),
            )
            agent = module.AgentCliHarborAgent(logs_dir=Path(tmp) / "logs")

            with self.assertRaises(RuntimeError) as raised:
                await agent.setup(env)
            self.assertIn("usage blew up", str(raised.exception))
            self.assertIn("missing runtime", str(raised.exception))

    async def test_run_forwards_harness_kwargs_as_cli_flags(self):
        module = import_agent_module()
        with TemporaryDirectory() as tmp:
            exec_commands = []

            async def exec_side_effect(command, **kwargs):
                exec_commands.append((command, kwargs))
                if command.startswith("test -f "):
                    return SimpleNamespace(return_code=1, stdout="", stderr="")
                if command.startswith("test -d "):
                    return SimpleNamespace(return_code=1, stdout="", stderr="")
                return SimpleNamespace(return_code=0, stdout="", stderr="")

            env = SimpleNamespace(
                exec=AsyncMock(side_effect=exec_side_effect),
                upload_file=AsyncMock(),
                upload_dir=AsyncMock(),
                download_file=AsyncMock(),
            )
            context = SimpleNamespace(task_id="task-a")
            agent = module.AgentCliHarborAgent(
                logs_dir=Path(tmp) / "logs",
                generic_validation_enabled=True,
                validation_timeout_sec=45,
                precheck_command="pytest",
                precheck_timeout_sec=30,
                precheck_retry_limit=2,
                pre_verifier_cleanup_globs="/tmp/frame*.bmp",
                harbor_agent_timeout_sec=600,
                agent_timeout_grace_sec=15,
                retry_min_budget_sec=90,
            )

            await agent.run("fix the task", env, context)

            main_commands = [item for item in exec_commands if "/usr/local/bin/agent solve" in item[0]]
            self.assertEqual(len(main_commands), 1)
            command, kwargs = main_commands[0]
            self.assertIn("--validation-mode auto", command)
            self.assertIn("--validation-retry-limit 2", command)
            self.assertIn("--validation-timeout-sec 45", command)
            self.assertIn("--precheck-command pytest", command)
            self.assertIn("--precheck-timeout-sec 30", command)
            self.assertIn("--pre-verifier-cleanup-globs '/tmp/frame*.bmp'", command)
            self.assertIn("--harness-timeout-sec 600", command)
            self.assertIn("--retry-min-budget-sec 90", command)
            self.assertIn("--attempts-dir /tmp/agent/attempts", command)
            self.assertEqual(kwargs["timeout_sec"], 615)
            self.assertFalse(any("sigma-precheck" in command for command, _kwargs in exec_commands))
            self.assertFalse(any("sigma-validation" in command for command, _kwargs in exec_commands))

    async def test_run_uses_validation_off_when_generic_validation_disabled(self):
        module = import_agent_module()
        with TemporaryDirectory() as tmp:
            exec_commands = []

            async def exec_side_effect(command, **kwargs):
                exec_commands.append((command, kwargs))
                if command.startswith("test -f ") or command.startswith("test -d "):
                    return SimpleNamespace(return_code=1, stdout="", stderr="")
                return SimpleNamespace(return_code=0, stdout="", stderr="")

            env = SimpleNamespace(
                exec=AsyncMock(side_effect=exec_side_effect),
                upload_file=AsyncMock(),
                upload_dir=AsyncMock(),
                download_file=AsyncMock(),
            )
            context = SimpleNamespace(task_id="task-a")
            agent = module.AgentCliHarborAgent(logs_dir=Path(tmp) / "logs")

            await agent.run("fix the task", env, context)

            command = [command for command, _kwargs in exec_commands if "/usr/local/bin/agent solve" in command][0]
            self.assertIn("--validation-mode off", command)
            self.assertIn("--validation-retry-limit 0", command)

    async def test_run_downloads_logs_populates_context_and_mirrors_harness_metadata(self):
        module = import_agent_module()
        with TemporaryDirectory() as tmp:
            old_run_dir = os.environ.get("SIGMA_BENCH_RUN_DIR")
            os.environ["SIGMA_BENCH_RUN_DIR"] = tmp
            logs_dir = Path(tmp) / "logs"
            summary_json = {
                "status": "error",
                "finish_reason": "validation_failed",
                "commands_executed": 7,
                "input_tokens": 11,
                "output_tokens": 13,
                "cache_tokens": 2,
                "cost_usd": 0.123,
                "last_error": "validation command failed with exit code 1",
                "harness": {
                    "attempts": [
                        {
                            "attempt": 1,
                            "status": "completed",
                            "finish_reason": "assistant_stop",
                            "summary_path": "attempts/attempt-1/summary.json",
                            "trace_path": "attempts/attempt-1/trace.jsonl",
                        }
                    ],
                    "validation_results": [
                        {
                            "kind": "validation",
                            "command": "python check.py",
                            "exit_code": 1,
                            "related_files": ["check.py"],
                        }
                    ],
                    "precheck_results": [],
                    "retry_decisions": [{"action": "skipped", "trigger": "validation"}],
                    "pre_verifier_cleanup": {"patterns": ["/tmp/frame*.bmp"], "exit_code": 1, "warning": "cleanup failed"},
                },
            }

            async def exec_side_effect(command, **kwargs):
                if command.startswith("test -f "):
                    return SimpleNamespace(return_code=0, stdout="", stderr="")
                if command.startswith("test -d "):
                    return SimpleNamespace(return_code=1, stdout="", stderr="")
                if "/usr/local/bin/agent solve" in command:
                    return SimpleNamespace(return_code=1, stdout="agent failed", stderr="")
                return SimpleNamespace(return_code=0, stdout="", stderr="")

            async def download_side_effect(source_path, target_path):
                target = Path(target_path)
                target.parent.mkdir(parents=True, exist_ok=True)
                if source_path.endswith("summary.json"):
                    target.write_text(json.dumps(summary_json), encoding="utf-8")
                else:
                    target.write_text('{"type":"run_end"}\n', encoding="utf-8")

            try:
                env = SimpleNamespace(
                    exec=AsyncMock(side_effect=exec_side_effect),
                    upload_file=AsyncMock(),
                    upload_dir=AsyncMock(),
                    download_file=AsyncMock(side_effect=download_side_effect),
                )
                context = SimpleNamespace(task_id="openssl-selfsigned-cert")
                agent = module.AgentCliHarborAgent(logs_dir=logs_dir)

                await agent.run("fix the task", env, context)

                env.download_file.assert_any_await("/tmp/agent/summary.json", logs_dir / "summary.json")
                env.download_file.assert_any_await("/tmp/agent/trace.jsonl", logs_dir / "trace.jsonl")
                self.assertEqual(context.exit_code, 1)
                self.assertEqual(context.commands_executed, 7)
                self.assertEqual(context.n_input_tokens, 11)
                self.assertEqual(context.n_output_tokens, 13)
                self.assertEqual(context.n_cache_tokens, 2)
                self.assertEqual(context.cost_usd, 0.123)

                metadata = json.loads(
                    (Path(tmp) / "tasks" / "openssl-selfsigned-cert" / "metadata.json").read_text(encoding="utf-8")
                )
                self.assertEqual(metadata["validation_results"][0]["command"], "python check.py")
                self.assertEqual(metadata["pre_verifier_cleanup"]["warning"], "cleanup failed")
                self.assertIn("validation_failed", metadata["failure_signals"])
                self.assertIn("retry_cut_short_by_budget", metadata["failure_signals"])
                self.assertIn("pre_verifier_cleanup_warning", metadata["failure_signals"])
            finally:
                if old_run_dir is None:
                    os.environ.pop("SIGMA_BENCH_RUN_DIR", None)
                else:
                    os.environ["SIGMA_BENCH_RUN_DIR"] = old_run_dir


if __name__ == "__main__":
    unittest.main()
