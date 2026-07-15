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


def import_portable_agent_module():
    install_harbor_stubs()
    sys.modules.pop("portable.harbor.sigma_harbor_agent", None)
    return importlib.import_module("portable.harbor.sigma_harbor_agent")


class HarborAgentTest(unittest.IsolatedAsyncioTestCase):
    async def test_model_name_is_used_unless_model_is_explicit(self):
        module = import_portable_agent_module()

        self.assertEqual(module.SigmaCliHarborAgent(model_name="custom-model").model, "custom-model")
        self.assertEqual(
            module.SigmaCliHarborAgent(model="explicit-model", model_name="custom-model").model,
            "explicit-model",
        )
        self.assertEqual(module.SigmaCliHarborAgent(provider="deepseek").model, "deepseek-v4-pro")
        self.assertEqual(module.SigmaCliHarborAgent(provider="glm").model, "glm-5.2")

    async def test_setup_prefers_uploaded_tarball(self):
        module = import_portable_agent_module()
        with TemporaryDirectory() as tmp:
            tarball = Path(tmp) / "agent-cli-linux-x64.tgz"
            tarball.write_bytes(b"fake")
            old_tarball = os.environ.get("AGENT_CLI_TARBALL")
            os.environ.pop("AGENT_CLI_TARBALL", None)
            try:
                env = SimpleNamespace(
                    exec=AsyncMock(
                        side_effect=[
                            SimpleNamespace(return_code=0, stdout="/app\n", stderr=""),
                            SimpleNamespace(return_code=0),
                            SimpleNamespace(return_code=0),
                            SimpleNamespace(return_code=1),
                            SimpleNamespace(return_code=0),
                            SimpleNamespace(return_code=0, stdout="usage", stderr=""),
                            SimpleNamespace(return_code=0, stdout='{"status":"ok"}', stderr=""),
                        ]
                    ),
                    upload_file=AsyncMock(),
                    upload_dir=AsyncMock(),
                    download_file=AsyncMock(),
                )
                agent = module.SigmaCliHarborAgent(logs_dir=Path(tmp) / "logs", agent_cli_tarball=tarball)

                await agent.setup(env)

                env.upload_file.assert_awaited_once_with(tarball, "/tmp/agent/agent-cli.tgz")
                env.upload_dir.assert_not_called()
                self.assertEqual(env.exec.await_count, 7)
                commands = [call.args[0] for call in env.exec.await_args_list]
                self.assertFalse(any("command -v node" in command for command in commands))
                self.assertIn("/usr/local/bin/agent --help", commands)
            finally:
                if old_tarball is None:
                    os.environ.pop("AGENT_CLI_TARBALL", None)
                else:
                    os.environ["AGENT_CLI_TARBALL"] = old_tarball

    async def test_setup_checks_existing_agent_help(self):
        module = import_portable_agent_module()
        with TemporaryDirectory() as tmp:
            env = SimpleNamespace(
                exec=AsyncMock(
                    side_effect=[
                        SimpleNamespace(return_code=0, stdout="/app\n", stderr=""),
                        SimpleNamespace(return_code=0),
                        SimpleNamespace(return_code=0),
                        SimpleNamespace(return_code=0),
                        SimpleNamespace(return_code=0, stdout="usage", stderr=""),
                        SimpleNamespace(return_code=0, stdout='{"status":"ok"}', stderr=""),
                    ]
                ),
                upload_file=AsyncMock(),
                upload_dir=AsyncMock(),
                download_file=AsyncMock(),
            )
            agent = module.SigmaCliHarborAgent(logs_dir=Path(tmp) / "logs")

            await agent.setup(env)

            commands = [call.args[0] for call in env.exec.await_args_list]
            self.assertEqual(
                commands,
                [
                    "pwd -P",
                    "test -d /app && test -r /app && test -x /app",
                    "mkdir -p /tmp/agent",
                    "command -v /usr/local/bin/agent >/dev/null 2>&1",
                    "/usr/local/bin/agent --help",
                    "/usr/local/bin/agent doctor --workspace /app --json --strict",
                ],
            )

    async def test_setup_doctor_failure_is_classified_and_persisted(self):
        module = import_portable_agent_module()
        with TemporaryDirectory() as tmp:
            logs_dir = Path(tmp) / "logs"
            env = SimpleNamespace(
                exec=AsyncMock(
                    side_effect=[
                        SimpleNamespace(return_code=0, stdout="/app\n", stderr=""),
                        SimpleNamespace(return_code=0),
                        SimpleNamespace(return_code=0),
                        SimpleNamespace(return_code=0),
                        SimpleNamespace(return_code=0, stdout="usage", stderr=""),
                        SimpleNamespace(
                            return_code=3,
                            stdout='{"status":"failed","checks":[{"id":"broker","ok":false}]}',
                            stderr="loader failed: ENOENT",
                        ),
                    ]
                ),
                upload_file=AsyncMock(),
                upload_dir=AsyncMock(),
                download_file=AsyncMock(),
            )
            agent = module.SigmaCliHarborAgent(logs_dir=logs_dir)

            with self.assertRaises(RuntimeError) as raised:
                await agent.setup(env)

            message = str(raised.exception)
            self.assertIn("agent_setup_failed: stage=strict_doctor exit_code=3", message)
            self.assertIn("loader failed: ENOENT", message)
            self.assertIn('"id": "broker"', message)
            record = json.loads((logs_dir / "setup-check.json").read_text(encoding="utf-8"))
            self.assertEqual(record["classification"], "agent_setup_failed")
            self.assertEqual(record["checks"][1]["exit_code"], 3)

    async def test_setup_help_failure_includes_stdout_and_stderr(self):
        module = import_portable_agent_module()
        with TemporaryDirectory() as tmp:
            env = SimpleNamespace(
                exec=AsyncMock(
                    side_effect=[
                        SimpleNamespace(return_code=0, stdout="/app\n", stderr=""),
                        SimpleNamespace(return_code=0),
                        SimpleNamespace(return_code=0),
                        SimpleNamespace(return_code=0),
                        SimpleNamespace(return_code=2, stdout="usage blew up", stderr="missing runtime"),
                    ]
                ),
                upload_file=AsyncMock(),
                upload_dir=AsyncMock(),
                download_file=AsyncMock(),
            )
            agent = module.SigmaCliHarborAgent(logs_dir=Path(tmp) / "logs")

            with self.assertRaises(RuntimeError) as raised:
                await agent.setup(env)
            self.assertIn("usage blew up", str(raised.exception))
            self.assertIn("missing runtime", str(raised.exception))

    async def test_run_forwards_only_v2_runtime_flags(self):
        module = import_portable_agent_module()
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
            agent = module.SigmaCliHarborAgent(
                logs_dir=Path(tmp) / "logs",
                max_wall_time_sec=600,
                agent_timeout_grace_sec=15,
            )
            agent._workspace = "/app"

            await agent.run("fix the task", env, context)

            main_commands = [item for item in exec_commands if "/usr/local/bin/agent run" in item[0]]
            self.assertEqual(len(main_commands), 1)
            command, kwargs = main_commands[0]
            self.assertIn("--prompt-file /tmp/agent/instruction.md", command)
            self.assertIn("--run-deadline-sec 600", command)
            self.assertIn("--permission-mode auto", command)
            self.assertIn("--output-format stream-json", command)
            self.assertIn("--output-schema 3", command)
            self.assertNotIn("--validation", command)
            self.assertNotIn("--retry", command)
            self.assertNotIn("--attempts-dir", command)
            self.assertEqual(kwargs["timeout_sec"], 615)
            self.assertFalse(any("sigma-precheck" in command for command, _kwargs in exec_commands))
            self.assertFalse(any("sigma-validation" in command for command, _kwargs in exec_commands))

    async def test_run_forwards_provider_model_and_deadline(self):
        module = import_portable_agent_module()
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
            agent = module.SigmaCliHarborAgent(
                logs_dir=Path(tmp) / "logs",
                provider="glm",
                model="glm-test",
                max_wall_time_sec=700,
                agent_timeout_grace_sec=20,
            )
            agent._workspace = "/app"

            await agent.run("fix the task", env, context)

            command, kwargs = [item for item in exec_commands if "/usr/local/bin/agent run" in item[0]][0]
            self.assertIn("--provider glm", command)
            self.assertIn("--model glm-test", command)
            self.assertIn("--run-deadline-sec 700", command)
            self.assertEqual(kwargs["timeout_sec"], 720)

    async def test_run_has_no_legacy_controller_flags_by_default(self):
        module = import_portable_agent_module()
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
            agent = module.SigmaCliHarborAgent(logs_dir=Path(tmp) / "logs")
            agent._workspace = "/app"

            await agent.run("fix the task", env, context)

            command = [command for command, _kwargs in exec_commands if "/usr/local/bin/agent run" in command][0]
            self.assertIn("--run-deadline-sec 7200", command)
            self.assertNotIn("--validation", command)
            self.assertNotIn("--retry", command)

    async def test_run_collects_result_without_feeding_evaluation_back(self):
        module = import_portable_agent_module()
        with TemporaryDirectory() as tmp:
            old_run_dir = os.environ.get("SIGMA_BENCH_RUN_DIR")
            os.environ["SIGMA_BENCH_RUN_DIR"] = tmp
            logs_dir = Path(tmp) / "logs"
            result_json = {"status": "completed", "finishReason": "completed", "sessionId": "session", "finalMessage": "done"}

            async def exec_side_effect(command, **kwargs):
                if "/usr/local/bin/agent run" in command:
                    return SimpleNamespace(return_code=0, stdout=json.dumps(result_json) + "\n", stderr="")
                if command.startswith("test -f ") or command.startswith("test -d "):
                    return SimpleNamespace(return_code=1, stdout="", stderr="")
                return SimpleNamespace(return_code=0, stdout="", stderr="")

            try:
                env = SimpleNamespace(
                    exec=AsyncMock(side_effect=exec_side_effect),
                    upload_file=AsyncMock(),
                    upload_dir=AsyncMock(),
                    download_file=AsyncMock(),
                )
                context = SimpleNamespace(task_id="service-task")
                agent = module.SigmaCliHarborAgent(logs_dir=logs_dir)
                agent._workspace = "/app"

                await agent.run("fix the task", env, context)

                env.download_file.assert_not_awaited()
                self.assertEqual(context.exit_code, 0)
                self.assertEqual(context.commands_executed, 0)

                metadata = json.loads(
                    (Path(tmp) / "tasks" / "service-task" / "metadata.json").read_text(encoding="utf-8")
                )
                self.assertEqual(metadata["exit_code"], 0)
                self.assertEqual(metadata["failure_signals"], ["agent_setup_ok"])
                self.assertTrue((Path(tmp) / "tasks" / "service-task" / "agent.log").is_file())
            finally:
                if old_run_dir is None:
                    os.environ.pop("SIGMA_BENCH_RUN_DIR", None)
                else:
                    os.environ["SIGMA_BENCH_RUN_DIR"] = old_run_dir

    async def test_run_derives_usage_and_trace_from_stream_json(self):
        module = import_portable_agent_module()
        with TemporaryDirectory() as tmp:
            logs_dir = Path(tmp) / "logs"
            event = lambda seq, event_type, payload: {
                "kind": "event",
                "event": {
                    "eventId": f"event-{seq}",
                    "sessionId": "stream-session",
                    "seq": seq,
                    "type": event_type,
                    "payload": payload,
                },
            }
            stdout = "\n".join([
                json.dumps(event(1, "model.started", {"turnId": 1})),
                json.dumps(event(2, "usage.recorded", {
                    "inputTokens": 11,
                    "outputTokens": 7,
                    "cacheReadTokens": 3,
                    "cacheWriteTokens": 2,
                    "costMicroUsd": 19,
                })),
                json.dumps(event(3, "tool.requested", {"callId": "tool-1", "name": "execute"})),
                json.dumps(event(4, "tool.completed", {"callId": "tool-1", "name": "execute"})),
                json.dumps(event(5, "run.completed", {"message": "done"})),
                json.dumps({
                    "kind": "result",
                    "result": {
                        "status": "completed",
                        "finishReason": "completed",
                        "sessionId": "stream-session",
                        "finalMessage": "done",
                    },
                }),
            ])

            async def exec_side_effect(command, **kwargs):
                if "/usr/local/bin/agent run" in command:
                    return SimpleNamespace(return_code=0, stdout=stdout, stderr="")
                if command.startswith("test -f ") or command.startswith("test -d "):
                    return SimpleNamespace(return_code=1, stdout="", stderr="")
                return SimpleNamespace(return_code=0, stdout="", stderr="")

            env = SimpleNamespace(
                exec=AsyncMock(side_effect=exec_side_effect),
                upload_file=AsyncMock(),
                upload_dir=AsyncMock(),
                download_file=AsyncMock(),
            )
            context = SimpleNamespace(task_id="stream-accounting")
            agent = module.SigmaCliHarborAgent(logs_dir=logs_dir)
            agent._workspace = "/app"

            await agent.run("run", env, context)

            self.assertEqual(context.exit_code, 0)
            self.assertEqual(context.n_input_tokens, 11)
            self.assertEqual(context.n_output_tokens, 7)
            self.assertEqual(context.n_cache_tokens, 5)
            self.assertEqual(context.model_turns, 1)
            self.assertEqual(context.tool_calls, 1)
            summary = json.loads((logs_dir / "summary.json").read_text(encoding="utf-8"))
            self.assertEqual(summary["input_tokens"], 11)
            self.assertEqual(summary["model_turns"], 1)
            trace_types = [
                json.loads(line)["type"]
                for line in (logs_dir / "trace.jsonl").read_text(encoding="utf-8").splitlines()
            ]
            self.assertIn("usage", trace_types)
            self.assertIn("tool_end", trace_types)
            self.assertIn("run_end", trace_types)

    async def test_run_resolves_checkpoint_recovery_without_interactive_input(self):
        module = import_portable_agent_module()
        with TemporaryDirectory() as tmp:
            initial_events = [
                {
                    "kind": "event",
                    "event": {
                        "eventId": "suspend",
                        "sessionId": "recover-session",
                        "seq": 1,
                        "type": "run.suspended",
                        "payload": {"checkpointId": "checkpoint-1", "choices": ["restore", "keep"]},
                    },
                }
            ]
            initial_stdout = "\n".join([
                json.dumps(item) for item in initial_events
            ] + [json.dumps({
                "kind": "result",
                "result": {
                    "status": "needs_input",
                    "finishReason": "checkpoint_recovery",
                    "sessionId": "recover-session",
                },
            })])
            resumed_events = {
                "events": [
                    initial_events[0]["event"],
                    {
                        "eventId": "resolved",
                        "sessionId": "recover-session",
                        "seq": 2,
                        "type": "checkpoint.recovery_resolved",
                        "payload": {"checkpointId": "checkpoint-1", "decision": "restore"},
                    },
                    {
                        "eventId": "completed",
                        "sessionId": "recover-session",
                        "seq": 3,
                        "type": "run.completed",
                        "payload": {"message": "done"},
                    },
                ]
            }
            commands = []

            async def exec_side_effect(command, **kwargs):
                commands.append(command)
                if "/usr/local/bin/agent run" in command:
                    return SimpleNamespace(return_code=0, stdout=initial_stdout, stderr="")
                if "/usr/local/bin/agent session show" in command:
                    return SimpleNamespace(return_code=0, stdout=json.dumps(resumed_events) + "\n", stderr="")
                if command.startswith("test -f ") or command.startswith("test -d "):
                    return SimpleNamespace(return_code=1, stdout="", stderr="")
                return SimpleNamespace(return_code=0, stdout="", stderr="")

            env = SimpleNamespace(
                exec=AsyncMock(side_effect=exec_side_effect),
                upload_file=AsyncMock(),
                upload_dir=AsyncMock(),
                download_file=AsyncMock(),
            )
            context = SimpleNamespace(task_id="recover-accounting")
            agent = module.SigmaCliHarborAgent(logs_dir=Path(tmp) / "logs")
            agent._workspace = "/app"

            await agent.run("run", env, context)

            recover_commands = [command for command in commands if " session recover " in command]
            self.assertEqual(len(recover_commands), 1)
            self.assertIn("--restore", recover_commands[0])
            self.assertEqual(context.exit_code, 0)
            self.assertIsNone(context.failure_kind)

    async def test_reviewer_waiver_is_explicit(self):
        module = import_portable_agent_module()
        with TemporaryDirectory() as tmp:
            commands = []

            async def exec_side_effect(command, **kwargs):
                commands.append(command)
                if command.startswith("test -f ") or command.startswith("test -d "):
                    return SimpleNamespace(return_code=1, stdout="", stderr="")
                return SimpleNamespace(return_code=0, stdout="", stderr="")

            env = SimpleNamespace(
                exec=AsyncMock(side_effect=exec_side_effect),
                upload_file=AsyncMock(),
                upload_dir=AsyncMock(),
                download_file=AsyncMock(),
            )
            agent = module.SigmaCliHarborAgent(
                logs_dir=Path(tmp) / "logs",
                reviewer_waiver_reason="operator reviewed opaque artifact",
            )
            agent._workspace = "/app"
            await agent.run("run", env, SimpleNamespace(task_id="waiver"))

            command = next(command for command in commands if "/usr/local/bin/agent run" in command)
            self.assertIn("--waive-reviewer", command)

    async def test_run_downloads_accounting_artifacts_and_propagates_agent_failure(self):
        module = import_portable_agent_module()
        with TemporaryDirectory() as tmp:
            logs_dir = Path(tmp) / "logs"
            run_dir = Path(tmp) / "run"
            old_run_dir = os.environ.get("SIGMA_BENCH_RUN_DIR")
            os.environ["SIGMA_BENCH_RUN_DIR"] = str(run_dir)

            async def exec_side_effect(command, **kwargs):
                if command.startswith("test -f "):
                    return SimpleNamespace(return_code=0, stdout="", stderr="")
                if command == "test -d /tmp/agent/attempts":
                    return SimpleNamespace(return_code=0, stdout="", stderr="")
                if command.startswith("find /tmp/agent/attempts"):
                    return SimpleNamespace(return_code=0, stdout="/tmp/agent/attempts/one/trace.jsonl\n", stderr="")
                if "/usr/local/bin/agent run" in command:
                    return SimpleNamespace(return_code=7, stdout="agent output", stderr="broker errno=5")
                return SimpleNamespace(return_code=0, stdout="", stderr="")

            async def download_file(remote_path, target_path):
                target_path.parent.mkdir(parents=True, exist_ok=True)
                if remote_path.endswith("summary.json"):
                    target_path.write_text(
                        json.dumps({
                            "commands_executed": 4,
                            "input_tokens": 12,
                            "output_tokens": 8,
                            "cache_tokens": 3,
                            "cost_usd": 0.25,
                            "last_error": "agent failed",
                        }),
                        encoding="utf-8",
                    )
                else:
                    target_path.write_text('{"type":"trace"}\n', encoding="utf-8")

            try:
                env = SimpleNamespace(
                    exec=AsyncMock(side_effect=exec_side_effect),
                    upload_file=AsyncMock(),
                    upload_dir=AsyncMock(),
                    download_file=AsyncMock(side_effect=download_file),
                )
                context = SimpleNamespace(task_id="run-unit")
                agent = module.SigmaCliHarborAgent(logs_dir=logs_dir)
                agent._workspace = "/app"

                with self.assertRaisesRegex(RuntimeError, "agent_failure"):
                    await agent.run("run", env, context)

                self.assertEqual(context.commands_executed, 4)
                self.assertEqual(context.n_input_tokens, 12)
                self.assertEqual(context.n_output_tokens, 8)
                self.assertEqual(context.n_cache_tokens, 3)
                self.assertEqual(context.failure_kind, "agent_failure")
                self.assertIn("broker errno=5", context.error_message)
                self.assertTrue((logs_dir / "summary.json").is_file())
                self.assertTrue((logs_dir / "trace.jsonl").is_file())
            finally:
                if old_run_dir is None:
                    os.environ.pop("SIGMA_BENCH_RUN_DIR", None)
                else:
                    os.environ["SIGMA_BENCH_RUN_DIR"] = old_run_dir


if __name__ == "__main__":
    unittest.main()
