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

    async def test_setup_does_not_probe_system_node(self):
        module = import_agent_module()
        with TemporaryDirectory() as tmp:
            async def exec_side_effect(command, **_kwargs):
                if "command -v node" in command:
                    raise AssertionError("setup should not probe system node")
                return SimpleNamespace(return_code=0, stdout="", stderr="")

            env = SimpleNamespace(
                exec=AsyncMock(side_effect=exec_side_effect),
                upload_file=AsyncMock(),
                upload_dir=AsyncMock(),
                download_file=AsyncMock(),
            )
            agent = module.AgentCliHarborAgent(logs_dir=Path(tmp) / "logs")

            await agent.setup(env)

            commands = [call.args[0] for call in env.exec.await_args_list]
            self.assertIn("/usr/local/bin/agent --help", commands)

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
            self.assertIn("--max-message-history-chars 250000", command)
            self.assertIn("--message-history-retain 24", command)
            self.assertIn("--compaction-summary-chars 30000", command)
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

    async def test_known_task_cleanup_runs_before_verifier_and_is_mirrored(self):
        module = import_agent_module()
        with TemporaryDirectory() as tmp:
            old_run_dir = os.environ.get("SIGMA_BENCH_RUN_DIR")
            os.environ["SIGMA_BENCH_RUN_DIR"] = tmp
            exec_commands = []

            async def exec_side_effect(command, **kwargs):
                exec_commands.append((command, kwargs))
                if command.startswith("test -f "):
                    return SimpleNamespace(return_code=1, stdout="", stderr="")
                if "python3 - <<'PY'" in command:
                    return SimpleNamespace(return_code=0, stdout='{"removed":["/tmp/frame.bmp"],"skipped":[]}', stderr="")
                return SimpleNamespace(return_code=0, stdout="", stderr="")

            try:
                env = SimpleNamespace(
                    exec=AsyncMock(side_effect=exec_side_effect),
                    upload_file=AsyncMock(),
                    upload_dir=AsyncMock(),
                    download_file=AsyncMock(),
                )
                context = SimpleNamespace(task_id="terminal-bench/make-mips-interpreter")
                agent = module.AgentCliHarborAgent(logs_dir=Path(tmp) / "logs")

                await agent.run("fix the task", env, context)

                cleanup_commands = [
                    command for command, _kwargs in exec_commands if "python3 - <<'PY'" in command and "removed = []" in command
                ]
                self.assertEqual(len(cleanup_commands), 1)
                self.assertIn("/tmp/frame*.bmp", cleanup_commands[0])
                metadata = json.loads(
                    (Path(tmp) / "tasks" / "terminal-bench-make-mips-interpreter" / "metadata.json").read_text(
                        encoding="utf-8"
                    )
                )
                self.assertEqual(metadata["pre_verifier_cleanup"]["patterns"], ["/tmp/frame*.bmp"])
                self.assertEqual(metadata["pre_verifier_cleanup"]["exit_code"], 0)
            finally:
                if old_run_dir is None:
                    os.environ.pop("SIGMA_BENCH_RUN_DIR", None)
                else:
                    os.environ["SIGMA_BENCH_RUN_DIR"] = old_run_dir

    async def test_known_task_cleanup_can_be_detected_from_logs_dir(self):
        module = import_agent_module()
        with TemporaryDirectory() as tmp:
            agent = module.AgentCliHarborAgent(
                logs_dir=Path(tmp) / "make-mips-interpreter__trial" / "agent",
            )

            self.assertEqual(agent._cleanup_globs_for_context(SimpleNamespace(task_id="uuid-only")), ["/tmp/frame*.bmp"])

    async def test_explicit_cleanup_globs_override_known_task_and_failures_are_warnings(self):
        module = import_agent_module()
        with TemporaryDirectory() as tmp:
            old_run_dir = os.environ.get("SIGMA_BENCH_RUN_DIR")
            os.environ["SIGMA_BENCH_RUN_DIR"] = tmp
            exec_commands = []

            async def exec_side_effect(command, **kwargs):
                exec_commands.append((command, kwargs))
                if command.startswith("test -f "):
                    return SimpleNamespace(return_code=1, stdout="", stderr="")
                if "python3 - <<'PY'" in command:
                    return SimpleNamespace(return_code=1, stdout="", stderr="cleanup failed")
                return SimpleNamespace(return_code=0, stdout="", stderr="")

            try:
                env = SimpleNamespace(
                    exec=AsyncMock(side_effect=exec_side_effect),
                    upload_file=AsyncMock(),
                    upload_dir=AsyncMock(),
                    download_file=AsyncMock(),
                )
                context = SimpleNamespace(task_id="terminal-bench/make-mips-interpreter")
                agent = module.AgentCliHarborAgent(
                    logs_dir=Path(tmp) / "logs",
                    pre_verifier_cleanup_globs="/tmp/custom*.bmp",
                )

                await agent.run("fix the task", env, context)

                cleanup_command = [
                    command for command, _kwargs in exec_commands if "python3 - <<'PY'" in command and "removed = []" in command
                ][0]
                self.assertIn("/tmp/custom*.bmp", cleanup_command)
                self.assertNotIn("/tmp/frame*.bmp", cleanup_command)
                metadata = json.loads(
                    (Path(tmp) / "tasks" / "terminal-bench-make-mips-interpreter" / "metadata.json").read_text(
                        encoding="utf-8"
                    )
                )
                self.assertEqual(metadata["pre_verifier_cleanup"]["exit_code"], 1)
                self.assertIn("warning", metadata["pre_verifier_cleanup"])
                self.assertEqual(context.exit_code, 0)
            finally:
                if old_run_dir is None:
                    os.environ.pop("SIGMA_BENCH_RUN_DIR", None)
                else:
                    os.environ["SIGMA_BENCH_RUN_DIR"] = old_run_dir

    async def test_precheck_failure_retries_with_feedback(self):
        module = import_agent_module()
        with TemporaryDirectory() as tmp:
            exec_commands = []
            uploaded_instructions = []
            precheck_calls = 0

            async def exec_side_effect(command, **kwargs):
                nonlocal precheck_calls
                exec_commands.append((command, kwargs))
                if "pytest" in command and "sigma-precheck" in command:
                    precheck_calls += 1
                    if precheck_calls == 1:
                        return SimpleNamespace(return_code=1, stdout="assertion failed", stderr="")
                    return SimpleNamespace(return_code=0, stdout="", stderr="")
                if command.startswith("test -f "):
                    return SimpleNamespace(return_code=1, stdout="", stderr="")
                return SimpleNamespace(return_code=0, stdout="", stderr="")

            async def upload_side_effect(source_path, target_path):
                if target_path == "/tmp/agent/instruction.md":
                    uploaded_instructions.append(Path(source_path).read_text(encoding="utf-8"))

            env = SimpleNamespace(
                exec=AsyncMock(side_effect=exec_side_effect),
                upload_file=AsyncMock(side_effect=upload_side_effect),
                upload_dir=AsyncMock(),
                download_file=AsyncMock(),
            )
            context = SimpleNamespace(task_id="task-a")
            agent = module.AgentCliHarborAgent(
                logs_dir=Path(tmp) / "logs",
                precheck_command="pytest",
                precheck_retry_limit=1,
            )

            await agent.run("fix the task", env, context)

            main_commands = [command for command, _kwargs in exec_commands if "/usr/local/bin/agent solve" in command]
            self.assertEqual(len(main_commands), 2)
            self.assertEqual(precheck_calls, 2)
            self.assertEqual(len(uploaded_instructions), 2)
            self.assertIn("Precheck failure 1", uploaded_instructions[1])
            self.assertIn("assertion failed", uploaded_instructions[1])
            self.assertEqual(len(agent._last_precheck_results), 2)

    async def test_generic_validation_builds_commands_for_changed_files(self):
        module = import_agent_module()
        with TemporaryDirectory() as tmp:
            agent = module.AgentCliHarborAgent(logs_dir=Path(tmp) / "logs", generic_validation_enabled=True)

            specs = agent._validation_command_specs(
                {},
                [
                    "/app/main.py",
                    "/app/check_cert.py",
                    "/app/validate.sh",
                    "/app/parser.js",
                ],
            )
            commands = [spec["command"] for spec in specs]

            self.assertIn("python -m py_compile /app/main.py", commands)
            self.assertIn("python -m py_compile /app/check_cert.py", commands)
            self.assertIn("cd /app && python /app/check_cert.py", commands)
            self.assertIn("bash -n /app/validate.sh", commands)
            self.assertIn("cd /app && bash /app/validate.sh", commands)
            self.assertTrue(any(" --check /app/parser.js" in command for command in commands))

    async def test_summary_validation_failure_retries_with_feedback(self):
        module = import_agent_module()
        with TemporaryDirectory() as tmp:
            exec_commands = []
            uploaded_instructions = []
            validation_calls = 0
            summary_json = json.dumps(
                {
                    "status": "completed",
                    "finish_reason": "assistant_stop",
                    "validation_commands": ["python /app/check_cert.py"],
                }
            )

            async def exec_side_effect(command, **kwargs):
                nonlocal validation_calls
                exec_commands.append((command, kwargs))
                if command.startswith("if [ -d /app ]; then"):
                    return SimpleNamespace(return_code=0, stdout="", stderr="")
                if "python /app/check_cert.py" in command and "sigma-validation" in command:
                    validation_calls += 1
                    if validation_calls == 1:
                        return SimpleNamespace(return_code=1, stdout="validation failed", stderr="")
                    return SimpleNamespace(return_code=0, stdout="", stderr="")
                if command.startswith("if [ -f /tmp/sigma-validation-1-1.stderr.log ]"):
                    return SimpleNamespace(return_code=0, stdout="certificate parse failed", stderr="")
                if command.startswith("if [ -f /tmp/sigma-validation-1-1.stdout.log ]"):
                    return SimpleNamespace(return_code=0, stdout="validation failed", stderr="")
                if command.startswith("if [ -f /tmp/agent/summary.json ]"):
                    return SimpleNamespace(return_code=0, stdout=summary_json, stderr="")
                if command.startswith("if [ -f /tmp/agent/trace.jsonl ]"):
                    return SimpleNamespace(return_code=0, stdout='{"type":"run_end"}\n', stderr="")
                if command.startswith("test -f "):
                    return SimpleNamespace(return_code=1, stdout="", stderr="")
                if "python3 - <<'PY'" in command:
                    return SimpleNamespace(return_code=0, stdout="[]", stderr="")
                return SimpleNamespace(return_code=0, stdout="", stderr="")

            async def upload_side_effect(source_path, target_path):
                if target_path == "/tmp/agent/instruction.md":
                    uploaded_instructions.append(Path(source_path).read_text(encoding="utf-8"))

            env = SimpleNamespace(
                exec=AsyncMock(side_effect=exec_side_effect),
                upload_file=AsyncMock(side_effect=upload_side_effect),
                upload_dir=AsyncMock(),
                download_file=AsyncMock(),
            )
            context = SimpleNamespace(task_id="openssl-selfsigned-cert")
            agent = module.AgentCliHarborAgent(
                logs_dir=Path(tmp) / "logs",
                generic_validation_enabled=True,
                validation_timeout_sec=45,
                precheck_retry_limit=1,
            )

            await agent.run("fix the task", env, context)

            main_commands = [command for command, _kwargs in exec_commands if "/usr/local/bin/agent solve" in command]
            self.assertEqual(len(main_commands), 2)
            self.assertEqual(validation_calls, 2)
            self.assertEqual(len(uploaded_instructions), 2)
            self.assertIn("Validation failure 1", uploaded_instructions[1])
            self.assertIn("python /app/check_cert.py", uploaded_instructions[1])
            self.assertIn("certificate parse failed", uploaded_instructions[1])
            self.assertEqual(agent._retry_decisions[0]["trigger"], "validation")

    async def test_validation_pass_does_not_retry_agent(self):
        module = import_agent_module()
        with TemporaryDirectory() as tmp:
            exec_commands = []
            summary_json = json.dumps(
                {
                    "status": "completed",
                    "finish_reason": "assistant_stop",
                    "validation_commands": ["python /app/check_cert.py"],
                }
            )

            async def exec_side_effect(command, **kwargs):
                exec_commands.append((command, kwargs))
                if command.startswith("if [ -d /app ]; then"):
                    return SimpleNamespace(return_code=0, stdout="", stderr="")
                if "python /app/check_cert.py" in command and "sigma-validation" in command:
                    return SimpleNamespace(return_code=0, stdout="", stderr="")
                if command.startswith("if [ -f /tmp/agent/summary.json ]"):
                    return SimpleNamespace(return_code=0, stdout=summary_json, stderr="")
                if command.startswith("if [ -f /tmp/agent/trace.jsonl ]"):
                    return SimpleNamespace(return_code=0, stdout='{"type":"run_end"}\n', stderr="")
                if command.startswith("test -f "):
                    return SimpleNamespace(return_code=1, stdout="", stderr="")
                if "python3 - <<'PY'" in command:
                    return SimpleNamespace(return_code=0, stdout="[]", stderr="")
                return SimpleNamespace(return_code=0, stdout="", stderr="")

            env = SimpleNamespace(
                exec=AsyncMock(side_effect=exec_side_effect),
                upload_file=AsyncMock(),
                upload_dir=AsyncMock(),
                download_file=AsyncMock(),
            )
            context = SimpleNamespace(task_id="openssl-selfsigned-cert")
            agent = module.AgentCliHarborAgent(
                logs_dir=Path(tmp) / "logs",
                generic_validation_enabled=True,
                validation_timeout_sec=45,
                precheck_retry_limit=1,
            )

            await agent.run("fix the task", env, context)

            main_commands = [command for command, _kwargs in exec_commands if "/usr/local/bin/agent solve" in command]
            self.assertEqual(len(main_commands), 1)
            self.assertEqual(agent._retry_decisions, [])

    async def test_validation_failure_with_insufficient_budget_reports_retry_cut_short(self):
        module = import_agent_module()
        with TemporaryDirectory() as tmp:
            old_run_dir = os.environ.get("SIGMA_BENCH_RUN_DIR")
            os.environ["SIGMA_BENCH_RUN_DIR"] = tmp
            summary_json = json.dumps(
                {
                    "status": "completed",
                    "finish_reason": "assistant_stop",
                    "validation_commands": ["python /app/check_cert.py"],
                }
            )

            async def exec_side_effect(command, **kwargs):
                if command.startswith("if [ -d /app ]; then"):
                    return SimpleNamespace(return_code=0, stdout="", stderr="")
                if "python /app/check_cert.py" in command and "sigma-validation" in command:
                    return SimpleNamespace(return_code=1, stdout="validation failed", stderr="")
                if command.startswith("if [ -f /tmp/agent/summary.json ]"):
                    return SimpleNamespace(return_code=0, stdout=summary_json, stderr="")
                if command.startswith("if [ -f /tmp/agent/trace.jsonl ]"):
                    return SimpleNamespace(return_code=0, stdout='{"type":"run_end"}\n', stderr="")
                if command.startswith("if [ -f /tmp/sigma-validation-1-1.stdout.log ]"):
                    return SimpleNamespace(return_code=0, stdout="validation failed", stderr="")
                if command.startswith("test -f "):
                    return SimpleNamespace(return_code=1, stdout="", stderr="")
                if "python3 - <<'PY'" in command:
                    return SimpleNamespace(return_code=0, stdout="[]", stderr="")
                return SimpleNamespace(return_code=0, stdout="", stderr="")

            try:
                env = SimpleNamespace(
                    exec=AsyncMock(side_effect=exec_side_effect),
                    upload_file=AsyncMock(),
                    upload_dir=AsyncMock(),
                    download_file=AsyncMock(),
                )
                context = SimpleNamespace(task_id="openssl-selfsigned-cert")
                agent = module.AgentCliHarborAgent(
                    logs_dir=Path(tmp) / "logs",
                    generic_validation_enabled=True,
                    validation_timeout_sec=45,
                    precheck_retry_limit=1,
                    harbor_agent_timeout_sec=1,
                    retry_min_budget_sec=999,
                )

                await agent.run("fix the task", env, context)

                self.assertEqual(agent._retry_decisions[0]["action"], "skipped")
                self.assertIn("retry skipped", context.error_message)
                metadata = json.loads((Path(tmp) / "tasks" / "openssl-selfsigned-cert" / "metadata.json").read_text(encoding="utf-8"))
                self.assertIn("validation_failed", metadata["failure_signals"])
                self.assertIn("retry_cut_short_by_harbor", metadata["failure_signals"])
            finally:
                if old_run_dir is None:
                    os.environ.pop("SIGMA_BENCH_RUN_DIR", None)
                else:
                    os.environ["SIGMA_BENCH_RUN_DIR"] = old_run_dir

    async def test_active_make_mips_precheck_records_log_tails_and_snapshots(self):
        module = import_agent_module()
        with TemporaryDirectory() as tmp:
            old_run_dir = os.environ.get("SIGMA_BENCH_RUN_DIR")
            os.environ["SIGMA_BENCH_RUN_DIR"] = tmp
            exec_commands = []

            async def exec_side_effect(command, **kwargs):
                exec_commands.append((command, kwargs))
                if "node /app/vm.js" in command and "sigma-precheck" in command:
                    return SimpleNamespace(return_code=1, stdout="", stderr="File /tmp/frame.bmp does not exist\nvm failed")
                if command.startswith("if [ -f /tmp/sigma-precheck-1.stdout.log ]"):
                    return SimpleNamespace(return_code=0, stdout="boot log", stderr="")
                if command.startswith("if [ -f /tmp/sigma-precheck-1.stderr.log ]"):
                    return SimpleNamespace(return_code=0, stdout="File /tmp/frame.bmp does not exist\nvm failed", stderr="")
                if command.startswith("if [ -f /tmp/agent/summary.json ]"):
                    return SimpleNamespace(return_code=0, stdout='{"status":"completed","finish_reason":"assistant_stop"}', stderr="")
                if command.startswith("if [ -f /tmp/agent/trace.jsonl ]"):
                    return SimpleNamespace(return_code=0, stdout='{"type":"run_end","metadata":{"result":{"status":"completed"}}}\n', stderr="")
                if command.startswith("test -f "):
                    return SimpleNamespace(return_code=1, stdout="", stderr="")
                if "python3 - <<'PY'" in command and "removed = []" in command:
                    return SimpleNamespace(return_code=0, stdout='{"removed":[],"skipped":[]}', stderr="")
                if "python3 - <<'PY'" in command and "/app/vm.js" in command:
                    return SimpleNamespace(
                        return_code=0,
                        stdout=json.dumps(
                            [
                                {"remote_path": "/app/vm.js", "size": 123},
                                {"remote_path": "/tmp/sigma-precheck-1.stderr.log", "size": 42},
                            ]
                        ),
                        stderr="",
                    )
                return SimpleNamespace(return_code=0, stdout="", stderr="")

            async def download_side_effect(source_path, target_path):
                target = Path(target_path)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(f"downloaded {source_path}\n", encoding="utf-8")

            try:
                env = SimpleNamespace(
                    exec=AsyncMock(side_effect=exec_side_effect),
                    upload_file=AsyncMock(),
                    upload_dir=AsyncMock(),
                    download_file=AsyncMock(side_effect=download_side_effect),
                )
                context = SimpleNamespace(task_id="terminal-bench/make-mips-interpreter")
                precheck_command = (
                    "rm -f /tmp/frame*.bmp; cd /app; "
                    "timeout 35 node /app/vm.js; "
                    "test -s /tmp/frame.bmp"
                )
                agent = module.AgentCliHarborAgent(
                    logs_dir=Path(tmp) / "logs",
                    precheck_command=precheck_command,
                    precheck_timeout_sec=45,
                    precheck_retry_limit=0,
                )

                await agent.run("fix the task", env, context)

                precheck_commands = [
                    command for command, _kwargs in exec_commands if "sigma-precheck" in command and "node /app/vm.js" in command
                ]
                self.assertEqual(len(precheck_commands), 1)
                self.assertIn("timeout 35 node /app/vm.js", precheck_commands[0])
                self.assertEqual(agent._last_precheck_results[0]["stderr_tail"], "File /tmp/frame.bmp does not exist\nvm failed")

                task_dir = Path(tmp) / "tasks" / "terminal-bench-make-mips-interpreter"
                metadata = json.loads((task_dir / "metadata.json").read_text(encoding="utf-8"))
                self.assertIn("precheck_failed", metadata["failure_signals"])
                self.assertIn("missing_artifact:/tmp/frame.bmp", metadata["failure_signals"])
                self.assertTrue(any(snapshot["success"] for snapshot in metadata["workspace_snapshots"]))
                self.assertTrue((task_dir / "workspace" / "vm.js").is_file())
                self.assertTrue((task_dir / "workspace" / "tmp" / "sigma-precheck-1.stderr.log").is_file())
            finally:
                if old_run_dir is None:
                    os.environ.pop("SIGMA_BENCH_RUN_DIR", None)
                else:
                    os.environ["SIGMA_BENCH_RUN_DIR"] = old_run_dir

    async def test_max_wall_time_skips_retry_when_harbor_budget_is_too_small(self):
        module = import_agent_module()
        with TemporaryDirectory() as tmp:
            old_run_dir = os.environ.get("SIGMA_BENCH_RUN_DIR")
            os.environ["SIGMA_BENCH_RUN_DIR"] = tmp
            exec_commands = []

            async def exec_side_effect(command, **kwargs):
                exec_commands.append((command, kwargs))
                if "pytest" in command and "sigma-precheck" in command:
                    return SimpleNamespace(return_code=1, stdout="assertion failed", stderr="")
                if command.startswith("if [ -f /tmp/agent/summary.json ]"):
                    return SimpleNamespace(
                        return_code=0,
                        stdout='{"status":"stopped","finish_reason":"max_wall_time","commands_executed":1}',
                        stderr="",
                    )
                if command.startswith("if [ -f /tmp/agent/trace.jsonl ]"):
                    return SimpleNamespace(
                        return_code=0,
                        stdout='{"type":"run_end","metadata":{"result":{"status":"stopped","finishReason":"max_wall_time"}}}\n',
                        stderr="",
                    )
                if command.startswith("test -f "):
                    return SimpleNamespace(return_code=1, stdout="", stderr="")
                if "python3 - <<'PY'" in command:
                    return SimpleNamespace(return_code=0, stdout="[]", stderr="")
                return SimpleNamespace(return_code=0, stdout="", stderr="")

            try:
                env = SimpleNamespace(
                    exec=AsyncMock(side_effect=exec_side_effect),
                    upload_file=AsyncMock(),
                    upload_dir=AsyncMock(),
                    download_file=AsyncMock(),
                )
                context = SimpleNamespace(task_id="task-a")
                agent = module.AgentCliHarborAgent(
                    logs_dir=Path(tmp) / "logs",
                    max_wall_time_sec=2700,
                    command_timeout_sec=180,
                    precheck_command="pytest",
                    precheck_timeout_sec=45,
                    precheck_retry_limit=1,
                    harbor_agent_timeout_sec=120,
                )

                await agent.run("fix the task", env, context)

                main_commands = [command for command, _kwargs in exec_commands if "/usr/local/bin/agent solve" in command]
                self.assertEqual(len(main_commands), 1)
                self.assertEqual(agent._retry_decisions[0]["action"], "skipped")
                self.assertIn("retry skipped", context.error_message)
                metadata = json.loads((Path(tmp) / "tasks" / "task-a" / "metadata.json").read_text(encoding="utf-8"))
                self.assertIn("retry_cut_short_by_harbor", metadata["failure_signals"])
            finally:
                if old_run_dir is None:
                    os.environ.pop("SIGMA_BENCH_RUN_DIR", None)
                else:
                    os.environ["SIGMA_BENCH_RUN_DIR"] = old_run_dir


if __name__ == "__main__":
    unittest.main()
