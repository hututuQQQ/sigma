import asyncio
import base64
import contextlib
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


def current_doctor_payload(
    network_modes: list[str] | None = None,
    *,
    container: bool = False,
) -> str:
    payload = {
        "doctorSchemaVersion": 1,
        "status": "ok",
        "strict": True,
        "protocolVersion": 1,
        "brokerVersion": "fixture",
        "platform": "linux",
        "architecture": "x86_64",
        "sandbox": {"available": True, "backend": "fixture", "selfTestPassed": True},
        "capabilities": {
            "networkModes": network_modes or ["none", "full"],
            "processHandoff": True,
        },
        "checks": [],
    }
    if container:
        payload["sandbox"]["backend"] = "oci"
        payload["container"] = {
            "available": True,
            "backend": "oci",
            "engine": "docker",
            "target": "managed",
            "targetId": "main-container-id",
            "targetStartedAt": "2026-07-19T00:00:00Z",
            "imageId": "sha256:" + "1" * 64,
            "imageDigest": "sha256:" + "2" * 64,
            "helperDigest": "sha256:" + "4" * 64,
            "attestationDigest": "sha256:" + "3" * 64,
        }
    return json.dumps(payload)


def completed_stream(session_id: str = "test-session", message: str = "done") -> str:
    event = {
        "kind": "event",
        "event": {
            "eventId": f"{session_id}-completed",
            "sessionId": session_id,
            "type": "run.completed",
            "payload": {
                "kind": "completed",
                "message": message,
                "evidence": [],
            },
        },
    }
    result = {
        "kind": "result",
        "result": {
            "status": "completed",
            "finishReason": "completed",
            "sessionId": session_id,
            "finalMessage": message,
        },
    }
    return json.dumps(event) + "\n" + json.dumps(result) + "\n"


class HarborAgentTest(unittest.IsolatedAsyncioTestCase):
    def test_preserves_completed_with_limitations_as_successful_distinct_terminal(self):
        module = import_portable_agent_module()
        with TemporaryDirectory() as tmp:
            agent = module.SigmaCliHarborAgent(logs_dir=Path(tmp) / "logs")
            limitation = {
                "kind": "validation_capability_unavailable",
                "claim": "unit",
                "attemptedCommandSummary": "pnpm test",
                "capabilityEvidenceId": "validation-proof",
                "reason": "The test runner is unavailable.",
            }
            event = {
                "type": "run.completed",
                "sessionId": "session-limited",
                "payload": {
                    "kind": "completed_with_limitations",
                    "message": "artifact produced",
                    "evidence": [],
                    "limitations": [limitation],
                },
            }

            terminal = agent._terminal_result([event], "session-limited")
            self.assertEqual(terminal["status"], "completed_with_limitations")
            self.assertEqual(terminal["finishReason"], "completed_with_limitations")
            wrapped = agent._result_with_payload(SimpleNamespace(stdout="", stderr=""), terminal)
            self.assertEqual(wrapped["return_code"], 0)
            summary = agent._summary_from_events([event], terminal)
            self.assertEqual(summary["status"], "completed_with_limitations")
            self.assertEqual(summary["limitation_count"], 1)
            self.assertEqual(summary["limitations"], [limitation])
            context = SimpleNamespace()
            agent._populate_context(context, wrapped, summary, None)
            self.assertEqual(context.completion_limitation_count, 1)
            self.assertEqual(context.completion_limitations, [limitation])

    def test_rejects_malformed_or_inconsistent_limited_completion_protocol(self):
        module = import_portable_agent_module()
        agent = module.SigmaCliHarborAgent()
        malformed = {
            "type": "run.completed",
            "sessionId": "session-malformed",
            "payload": {
                "kind": "completed_with_limitations",
                "message": "done",
                "evidence": [],
                "limitations": [],
            },
        }

        terminal = agent._terminal_result([malformed], "session-malformed")
        self.assertEqual(terminal["status"], "failed")
        self.assertIn("non-empty limitations", terminal["protocolError"])

        limitation = {
            "kind": "validation_capability_unavailable",
            "claim": "unit",
            "attemptedCommandSummary": "make test",
            "capabilityEvidenceId": "validation-proof",
            "reason": "make is unavailable",
        }
        limited_event = {
            "type": "run.completed",
            "sessionId": "session-mismatch",
            "payload": {
                "kind": "completed_with_limitations",
                "message": "done",
                "evidence": [],
                "limitations": [limitation],
            },
        }
        recorded = agent._recorded_terminal_result([limited_event], {
            "status": "completed",
            "finishReason": "completed",
            "sessionId": "session-mismatch",
        })
        self.assertEqual(recorded["status"], "failed")
        self.assertIn("disagree about completion status", recorded["protocolError"])

        missing_event = agent._recorded_terminal_result([], {
            "status": "completed_with_limitations",
            "finishReason": "completed_with_limitations",
            "sessionId": "session-no-event",
            "limitations": [limitation],
        })
        self.assertEqual(missing_event["status"], "failed")
        self.assertIn("matching run.completed", missing_event["protocolError"])

        missing_ordinary_event = agent._recorded_terminal_result([], {
            "status": "completed",
            "finishReason": "completed",
            "sessionId": "session-no-ordinary-event",
        })
        self.assertEqual(missing_ordinary_event["status"], "failed")
        self.assertIn("matching run.completed", missing_ordinary_event["protocolError"])

    async def test_model_name_is_used_unless_model_is_explicit(self):
        module = import_portable_agent_module()

        self.assertEqual(module.SigmaCliHarborAgent(model_name="custom-model").model, "custom-model")
        self.assertEqual(
            module.SigmaCliHarborAgent(model="explicit-model", model_name="custom-model").model,
            "explicit-model",
        )
        self.assertEqual(module.SigmaCliHarborAgent(provider="deepseek").model, "deepseek-v4-pro")
        self.assertEqual(module.SigmaCliHarborAgent(provider="glm").model, "glm-5.2")
        with self.assertRaisesRegex(ValueError, "execution_mode"):
            module.SigmaCliHarborAgent(execution_mode="host")
        self.assertEqual(module.SigmaCliHarborAgent(network_mode="loopback").network_mode, "loopback")
        with self.assertRaisesRegex(ValueError, "agent_profile"):
            module.SigmaCliHarborAgent(agent_profile="untrusted")
        for key in ("max_turns", "command_timeout_sec"):
            with self.subTest(key=key):
                with self.assertRaisesRegex(ValueError, key):
                    module.SigmaCliHarborAgent(**{key: 0})

    async def test_container_execution_mode_is_forwarded_without_host_opt_in(self):
        module = import_portable_agent_module()
        with TemporaryDirectory() as tmp:
            agent = module.SigmaCliHarborAgent(
                logs_dir=Path(tmp) / "logs",
                execution_mode="container",
                max_turns=37,
                command_timeout_sec=91,
            )
            agent._workspace = "/app"

            command = agent._agent_command()
            session_command = agent._session_command("resume", "session-fixture")

            self.assertEqual(command[0], "/opt/sigma-control/agent-cli/bin/agent")
            self.assertIn("--execution-mode", command)
            self.assertIn("container", command)
            self.assertIn("--agent-profile", command)
            self.assertIn("standard", command)
            self.assertEqual(command[command.index("--permission-mode") + 1], "auto")
            self.assertEqual(command[command.index("--max-model-turns") + 1], "37")
            self.assertEqual(command[command.index("--command-timeout-sec") + 1], "91")
            self.assertEqual(session_command[0], "/opt/sigma-control/agent-cli/bin/agent")
            self.assertIn("--execution-mode", session_command)
            self.assertIn("container", session_command)
            self.assertIn("--agent-profile", session_command)
            self.assertIn("standard", session_command)
            self.assertEqual(
                session_command[session_command.index("--permission-mode") + 1],
                "auto",
            )
            self.assertEqual(session_command[session_command.index("--max-model-turns") + 1], "37")
            self.assertEqual(session_command[session_command.index("--command-timeout-sec") + 1], "91")
            self.assertNotIn("HOME=/tmp/agent/disposable-home", command)
            self.assertEqual(command[command.index("--container-target") + 1], "managed")
            self.assertEqual(session_command[session_command.index("--container-target") + 1], "managed")

    async def test_container_setup_never_manufactures_host_persistence(self):
        module = import_portable_agent_module()
        with TemporaryDirectory() as tmp:
            logs_dir = Path(tmp) / "logs"
            env = SimpleNamespace(service_exec=AsyncMock(side_effect=[
                SimpleNamespace(return_code=0, stdout="usage", stderr=""),
                SimpleNamespace(return_code=0, stdout=current_doctor_payload(container=True), stderr=""),
            ]))
            agent = module.SigmaCliHarborAgent(
                logs_dir=logs_dir,
                execution_mode="container",
            )
            agent._workspace = "/app"

            await agent._verify_agent_ready(env)

            commands = [call.args[0] for call in env.service_exec.await_args_list]
            self.assertTrue(all("disposable" not in command for command in commands))
            self.assertTrue(all(call.kwargs["service"] == "sigma-control" for call in env.service_exec.await_args_list))
            record = json.loads((logs_dir / "setup-check.json").read_text(encoding="utf-8"))
            self.assertEqual(record["classification"], "passed")
            self.assertEqual(record["execution_mode"], "container")
            self.assertEqual(record["agent_profile"], "standard")
            self.assertEqual(record["execution_backend"], "oci:docker")
            self.assertEqual(record["container_engine"], "docker")
            self.assertEqual(record["container_target"], "managed")
            self.assertEqual(
                [check["stage"] for check in record["checks"]],
                ["help", "strict_doctor"],
            )

    async def test_container_setup_uses_control_package_and_only_trusted_main_setup(self):
        module = import_portable_agent_module()
        with TemporaryDirectory() as tmp:
            tarball = Path(tmp) / "must-not-be-uploaded.tgz"
            tarball.write_bytes(b"unused")
            identity = "77:88\n"
            service_exec = AsyncMock(side_effect=[
                SimpleNamespace(return_code=0, stdout="", stderr=""),
                SimpleNamespace(return_code=0, stdout=identity, stderr=""),
                SimpleNamespace(return_code=0, stdout="usage", stderr=""),
                SimpleNamespace(return_code=0, stdout=current_doctor_payload(container=True), stderr=""),
            ])
            env = SimpleNamespace(
                exec=AsyncMock(return_value=SimpleNamespace(return_code=0, stdout=identity, stderr="")),
                service_exec=service_exec,
                service_download_file=AsyncMock(),
                upload_file=AsyncMock(),
                download_file=AsyncMock(),
            )
            agent = module.SigmaCliHarborAgent(
                logs_dir=Path(tmp) / "logs",
                agent_cli_tarball=tarball,
                execution_mode="container",
            )

            await agent.setup(env)

            env.exec.assert_awaited_once()
            main_command = env.exec.await_args.args[0]
            self.assertIn("test \"$(pwd -P)\" = /app", main_command)
            self.assertIn(
                "ln -sfn /opt/sigma-helper/bin/bwrap /usr/local/bin/bwrap",
                main_command,
            )
            self.assertNotIn("agent-cli.tgz", main_command)
            self.assertNotIn("DEEPSEEK", main_command)
            self.assertNotIn("/opt/sigma-control", main_command)
            self.assertNotIn("env", env.exec.await_args.kwargs)

            self.assertEqual(service_exec.await_count, 4)
            self.assertTrue(all(
                call.kwargs.get("service") == "sigma-control"
                for call in service_exec.await_args_list
            ))
            package_command = service_exec.await_args_list[0].args[0]
            self.assertIn("/opt/sigma-package/agent-cli.tgz", package_command)
            self.assertIn("/opt/sigma-control/agent-cli", package_command)
            self.assertIn("test -x /opt/sigma-helper/bin/sigma-exec", main_command)
            self.assertIn("test -x /opt/sigma-helper/bin/sigma-exec", package_command)
            self.assertIn(
                "if ( : > /opt/sigma-helper/.sigma-control-write-probe ) "
                "2>/dev/null; then",
                package_command,
            )
            self.assertNotIn(
                "if : > /opt/sigma-helper/.sigma-control-write-probe",
                package_command,
            )
            self.assertIn(
                "rm -f /opt/sigma-helper/.sigma-control-write-probe",
                package_command,
            )
            self.assertIn(
                'echo "control unexpectedly has write access to the trusted helper" >&2\n'
                "  exit 1",
                package_command,
            )
            self.assertNotIn("/opt/sigma-helper/.sigma-stage", package_command)
            self.assertNotIn("install -m 0555", package_command)
            self.assertNotIn("cp -R", package_command)
            self.assertIn("test ! -e /opt/sigma-helper/node_modules", package_command)
            self.assertNotIn(str(tarball), package_command)
            env.upload_file.assert_not_awaited()
            env.download_file.assert_not_awaited()

            setup_record = json.loads(
                (Path(tmp) / "logs" / "setup-check.json").read_text(encoding="utf-8")
            )
            self.assertEqual(setup_record["classification"], "passed")
            self.assertEqual(
                [check["stage"] for check in setup_record["checks"]],
                [
                    "control_package", "main_boundary", "control_workspace",
                    "help", "strict_doctor",
                ],
            )
            self.assertEqual(setup_record["container"]["targetId"], "main-container-id")

    async def test_container_setup_rejects_missing_service_capability_without_main_fallback(self):
        module = import_portable_agent_module()
        with TemporaryDirectory() as tmp:
            env = SimpleNamespace(
                exec=AsyncMock(),
                upload_file=AsyncMock(),
                download_file=AsyncMock(),
            )
            agent = module.SigmaCliHarborAgent(
                logs_dir=Path(tmp) / "logs",
                execution_mode="container",
            )

            with self.assertRaisesRegex(RuntimeError, "requires Harbor compose service_exec"):
                await agent.setup(env)

            env.exec.assert_not_awaited()
            env.upload_file.assert_not_awaited()
            env.download_file.assert_not_awaited()

            env_without_download = SimpleNamespace(
                exec=AsyncMock(),
                service_exec=AsyncMock(),
                download_file=AsyncMock(),
            )
            agent_without_download = module.SigmaCliHarborAgent(
                logs_dir=Path(tmp) / "logs-without-download",
                execution_mode="container",
            )
            with self.assertRaisesRegex(RuntimeError, "requires Harbor compose service_download_file"):
                await agent_without_download.setup(env_without_download)
            env_without_download.exec.assert_not_awaited()
            env_without_download.service_exec.assert_not_awaited()
            env_without_download.download_file.assert_not_awaited()

    async def test_container_doctor_requires_managed_attested_identity(self):
        module = import_portable_agent_module()
        with TemporaryDirectory() as tmp:
            payload = json.loads(current_doctor_payload(container=True))
            del payload["container"]["targetStartedAt"]
            env = SimpleNamespace(service_exec=AsyncMock(side_effect=[
                SimpleNamespace(return_code=0, stdout="usage", stderr=""),
                SimpleNamespace(return_code=0, stdout=json.dumps(payload), stderr=""),
            ]))
            agent = module.SigmaCliHarborAgent(
                logs_dir=Path(tmp) / "logs",
                execution_mode="container",
            )
            agent._workspace = "/app"

            with self.assertRaisesRegex(RuntimeError, "container.targetStartedAt"):
                await agent._verify_agent_ready(env)

            self.assertTrue(all(
                call.kwargs.get("service") == "sigma-control"
                for call in env.service_exec.await_args_list
            ))

    async def test_container_run_and_artifacts_never_fall_back_to_main(self):
        module = import_portable_agent_module()
        with TemporaryDirectory() as tmp:
            instruction = "modify /app and validate it"
            encoded_instruction = base64.b64encode(
                instruction.encode("utf-8")
            ).decode("ascii")

            async def service_exec_side_effect(command, **_kwargs):
                if "/opt/sigma-control/agent-cli/bin/agent run" in command:
                    return SimpleNamespace(
                        return_code=0,
                        stdout="\n".join([
                            json.dumps({
                                "kind": "event",
                                "event": {
                                    "eventId": "completed",
                                    "sessionId": "container-session",
                                    "seq": 1,
                                    "type": "run.completed",
                                    "payload": {"kind": "completed", "message": "done", "evidence": []},
                                },
                            }),
                            json.dumps({
                                "kind": "result",
                                "result": {
                                    "status": "completed",
                                    "finishReason": "completed",
                                    "sessionId": "container-session",
                                },
                            }),
                        ]) + "\n",
                        stderr="",
                    )
                if command.startswith("test -f ") or command.startswith("test -d "):
                    return SimpleNamespace(return_code=1, stdout="", stderr="")
                return SimpleNamespace(return_code=0, stdout="", stderr="")

            env = SimpleNamespace(
                exec=AsyncMock(),
                service_exec=AsyncMock(side_effect=service_exec_side_effect),
                service_download_file=AsyncMock(),
                upload_file=AsyncMock(),
                download_file=AsyncMock(),
            )
            context = SimpleNamespace(task_id="container-routing")
            agent = module.SigmaCliHarborAgent(
                logs_dir=Path(tmp) / "logs",
                execution_mode="container",
                extra_env={"SIGMA_TEST_MARKER": "control-only"},
            )
            agent._workspace = "/app"
            agent.execution_backend = "oci:docker"
            agent.container_metadata = json.loads(current_doctor_payload(container=True))["container"]

            await agent.run(instruction, env, context)

            env.exec.assert_not_awaited()
            env.upload_file.assert_not_awaited()
            env.download_file.assert_not_awaited()
            env.service_download_file.assert_not_awaited()
            self.assertTrue(all(
                call.kwargs.get("service") == "sigma-control"
                for call in env.service_exec.await_args_list
            ))
            commands = [call.args[0] for call in env.service_exec.await_args_list]
            instruction_command = next(command for command in commands if "base64 -d" in command)
            self.assertIn(encoded_instruction, instruction_command)
            self.assertNotIn(instruction, instruction_command)
            run_call = next(
                call for call in env.service_exec.await_args_list
                if "/opt/sigma-control/agent-cli/bin/agent run" in call.args[0]
            )
            self.assertEqual(run_call.kwargs["env"]["SIGMA_TEST_MARKER"], "control-only")
            self.assertEqual(context.execution_backend, "oci:docker")
            self.assertEqual(context.container_target, "managed")
            self.assertEqual(context.target_image_id, "sha256:" + "1" * 64)
            summary = json.loads(
                (Path(tmp) / "logs" / "summary.json").read_text(encoding="utf-8")
            )
            self.assertEqual(summary["execution_backend"], "oci:docker")
            self.assertEqual(summary["container_target_id"], "main-container-id")
            self.assertEqual(summary["task_image_digest"], "sha256:" + "2" * 64)
            self.assertEqual(summary["max_turns"], 256)
            self.assertEqual(summary["command_timeout_sec"], 600)

    async def test_container_session_observation_uses_control_service(self):
        module = import_portable_agent_module()
        with TemporaryDirectory() as tmp:
            env = SimpleNamespace(
                exec=AsyncMock(),
                service_exec=AsyncMock(return_value=SimpleNamespace(
                    return_code=0,
                    stdout=json.dumps({"events": [{"type": "run.completed"}]}) + "\n",
                    stderr="",
                )),
            )
            agent = module.SigmaCliHarborAgent(
                logs_dir=Path(tmp) / "logs",
                execution_mode="container",
            )
            agent._workspace = "/app"

            events, error = await agent._read_session_events(
                env, "session-fixture", {"SIGMA_TEST_MARKER": "control-only"}
            )

            self.assertIsNone(error)
            self.assertEqual(events, [{"type": "run.completed"}])
            env.exec.assert_not_awaited()
            call = env.service_exec.await_args
            self.assertEqual(call.kwargs["service"], "sigma-control")
            self.assertEqual(call.kwargs["env"]["SIGMA_TEST_MARKER"], "control-only")
            self.assertIn(
                "/opt/sigma-control/agent-cli/bin/agent session show",
                call.args[0],
            )

    async def test_container_artifact_download_and_cleanup_use_control_service(self):
        module = import_portable_agent_module()
        with TemporaryDirectory() as tmp:
            target = Path(tmp) / "logs" / "summary.json"

            async def download_side_effect(_remote_path, target_path, **_kwargs):
                Path(target_path).write_text("{}\n", encoding="utf-8")

            env = SimpleNamespace(
                exec=AsyncMock(),
                download_file=AsyncMock(),
                service_exec=AsyncMock(side_effect=[
                    SimpleNamespace(return_code=0, stdout="", stderr=""),
                    SimpleNamespace(
                        return_code=0,
                        stdout='{"pid_recorded":true,"pid":42,"pgid":42,"status":"terminated"}\n',
                        stderr="",
                    ),
                ]),
                service_download_file=AsyncMock(side_effect=download_side_effect),
            )
            agent = module.SigmaCliHarborAgent(
                logs_dir=Path(tmp) / "logs",
                execution_mode="container",
            )

            downloaded = await agent._download_if_present(
                env, "/tmp/agent/summary.json", "summary.json"
            )
            cleanup = await agent._cleanup_remote_process(env)

            self.assertEqual(downloaded, target)
            self.assertEqual(cleanup["pid"], 42)
            env.exec.assert_not_awaited()
            env.download_file.assert_not_awaited()
            env.service_download_file.assert_awaited_once_with(
                "/tmp/agent/summary.json", target, service="sigma-control"
            )
            self.assertTrue(all(
                call.kwargs.get("service") == "sigma-control"
                for call in env.service_exec.await_args_list
            ))

    async def test_sandboxed_mode_observes_broker_image_identity_without_using_oci_execution(self):
        module = import_portable_agent_module()
        attestation = {
            "protocolVersion": 1,
            "engine": "docker",
            "selector": "compose-project/main",
            "targetId": "main-container-id",
            "targetStartedAt": "2026-07-19T00:00:00Z",
            "imageId": "sha256:" + "a" * 64,
            "imageDigest": "sha256:" + "b" * 64,
            "labelsDigest": "c" * 64,
            "helperDigest": "sha256:" + "e" * 64,
            "attestationDigest": "d" * 64,
            "workspace": "/app",
        }
        env = SimpleNamespace(service_exec=AsyncMock(return_value=SimpleNamespace(
            return_code=0, stdout=json.dumps(attestation), stderr=""
        )))
        agent = module.SigmaCliHarborAgent(
            execution_mode="sandboxed", managed_provenance=True
        )

        check = await agent._observe_managed_target_identity(env)

        self.assertEqual(check["stage"], "managed_target_identity")
        self.assertEqual(agent.container_metadata["imageId"], attestation["imageId"])
        self.assertEqual(agent.container_metadata["imageDigest"], attestation["imageDigest"])
        self.assertEqual(agent.container_metadata["target"], "managed")
        env.service_exec.assert_awaited_once_with(
            "cat /run/sigma-oci/attestation.json", service="sigma-control", timeout_sec=30
        )

    async def test_sandboxed_main_only_skips_missing_control_service(self):
        module = import_portable_agent_module()
        env = SimpleNamespace(service_exec=AsyncMock(
            side_effect=RuntimeError("service sigma-control is not running")
        ))
        agent = module.SigmaCliHarborAgent(execution_mode="sandboxed")

        check = await agent._observe_managed_target_identity(env)

        self.assertIsNone(check)
        env.service_exec.assert_not_awaited()

    async def test_requested_managed_provenance_fails_closed_without_attestation(self):
        module = import_portable_agent_module()
        with TemporaryDirectory() as tmp:
            env = SimpleNamespace(service_exec=AsyncMock(return_value=SimpleNamespace(
                return_code=1, stdout="", stderr="attestation unavailable"
            )))
            logs_dir = Path(tmp) / "logs"
            agent = module.SigmaCliHarborAgent(
                logs_dir=logs_dir,
                execution_mode="sandboxed",
                managed_provenance=True,
            )

            with self.assertRaisesRegex(RuntimeError, "managed_target_identity"):
                await agent._observe_managed_target_identity(env)

            setup_check = json.loads((logs_dir / "setup-check.json").read_text())
            self.assertEqual(setup_check["classification"], "agent_setup_failed")
            self.assertTrue(setup_check["managed_provenance"])

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
                            SimpleNamespace(return_code=0, stdout=current_doctor_payload(), stderr=""),
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
                        SimpleNamespace(return_code=0, stdout=current_doctor_payload(), stderr=""),
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
                    "/usr/local/bin/agent doctor --workspace /app --json --strict --check-api",
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

    async def test_setup_rejects_legacy_doctor_payload(self):
        module = import_portable_agent_module()
        with TemporaryDirectory() as tmp:
            env = SimpleNamespace(
                exec=AsyncMock(side_effect=[
                    SimpleNamespace(return_code=0, stdout="usage", stderr=""),
                    SimpleNamespace(return_code=0, stdout='{"status":"ok"}', stderr=""),
                ])
            )
            agent = module.SigmaCliHarborAgent(logs_dir=Path(tmp) / "logs")
            agent._workspace = "/app"

            with self.assertRaisesRegex(RuntimeError, "strict_doctor_contract") as raised:
                await agent._verify_agent_ready(env)

            self.assertIn("doctorSchemaVersion is missing or unsupported", str(raised.exception))
            record = json.loads((Path(tmp) / "logs" / "setup-check.json").read_text(encoding="utf-8"))
            self.assertEqual(record["classification"], "agent_setup_failed")
            self.assertEqual(record["checks"][1]["doctor_contract_error"], "doctorSchemaVersion is missing or unsupported")

    async def test_setup_accepts_current_doctor_contract_and_records_network_mode(self):
        module = import_portable_agent_module()
        with TemporaryDirectory() as tmp:
            env = SimpleNamespace(
                exec=AsyncMock(side_effect=[
                    SimpleNamespace(return_code=0, stdout="usage", stderr=""),
                    SimpleNamespace(return_code=0, stdout=current_doctor_payload(["none", "full"]), stderr=""),
                ])
            )
            agent = module.SigmaCliHarborAgent(logs_dir=Path(tmp) / "logs", network_mode="full")
            agent._workspace = "/app"

            await agent._verify_agent_ready(env)

            self.assertEqual(agent.available_network_modes, ["none", "full"])
            self.assertEqual(agent.effective_network_mode, "full")
            record = json.loads((Path(tmp) / "logs" / "setup-check.json").read_text(encoding="utf-8"))
            self.assertEqual(record["classification"], "passed")
            self.assertEqual(record["network_mode_effective"], "full")
            self.assertEqual(record["read_scope_effective"], "host")
            self.assertTrue(record["process_handoff_available"])

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
                if "/usr/local/bin/agent run" in command:
                    return SimpleNamespace(
                        return_code=0,
                        stdout=completed_stream("forward-v2"),
                        stderr="",
                    )
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
            self.assertIn("--agent-profile standard", command)
            self.assertIn("--output-format stream-json", command)
            self.assertIn("--output-schema 3", command)
            self.assertIn("--stream-json-max-line-bytes 49152", command)
            self.assertNotIn("--validation", command)
            self.assertNotIn("--retry", command)
            self.assertNotIn("--attempts-dir", command)
            self.assertEqual(kwargs["timeout_sec"], 615)
            self.assertFalse(any("sigma-precheck" in command for command, _kwargs in exec_commands))
            self.assertFalse(any("sigma-validation" in command for command, _kwargs in exec_commands))

    async def test_reassembles_bounded_stream_json_chunks(self):
        module = import_portable_agent_module()
        with TemporaryDirectory() as tmp:
            agent = module.SigmaCliHarborAgent(logs_dir=Path(tmp) / "logs")
            wrapped = {
                "schemaVersion": 3,
                "kind": "event",
                "type": "run.completed",
                "event": {
                    "eventId": "event-large",
                    "type": "run.completed",
                    "payload": {"kind": "completed", "message": "好" * 20_000},
                },
            }
            encoded = module.base64.b64encode(
                json.dumps(wrapped, ensure_ascii=False).encode("utf-8")
            ).decode("ascii")
            width = 4_000
            parts = [encoded[index:index + width] for index in range(0, len(encoded), width)]
            lines = [json.dumps({
                "schemaVersion": 3,
                "kind": "chunk",
                "recordId": "event-large",
                "index": index,
                "total": len(parts),
                "encoding": "base64-json-utf8",
                "data": part,
            }) for index, part in enumerate(parts)]
            lines.append(json.dumps({
                "schemaVersion": 3,
                "kind": "result",
                "type": "result",
                "result": {"status": "completed", "finishReason": "completed"},
            }))

            events, result = agent._parse_stream_output(SimpleNamespace(stdout="\n".join(lines)))

            self.assertEqual(events[0]["payload"]["message"], "好" * 20_000)
            self.assertEqual(result["status"], "completed")
            recorder = module._OutputRecorder(Path(tmp) / "recorder")
            recorder.record("\n".join(lines) + "\n", "stdout")
            self.assertEqual(recorder.events[0]["payload"]["message"], "好" * 20_000)
            self.assertEqual(recorder.output_result["status"], "completed")

    async def test_run_forwards_provider_model_and_deadline(self):
        module = import_portable_agent_module()
        with TemporaryDirectory() as tmp:
            exec_commands = []

            async def exec_side_effect(command, **kwargs):
                exec_commands.append((command, kwargs))
                if "/usr/local/bin/agent run" in command:
                    return SimpleNamespace(
                        return_code=0,
                        stdout=completed_stream("forward-provider"),
                        stderr="",
                    )
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
                network_mode="full",
                max_wall_time_sec=700,
                agent_timeout_grace_sec=20,
            )
            agent._workspace = "/app"

            await agent.run("fix the task", env, context)

            command, kwargs = [item for item in exec_commands if "/usr/local/bin/agent run" in item[0]][0]
            self.assertIn("--provider glm", command)
            self.assertIn("--model glm-test", command)
            self.assertIn("--agent-profile standard", command)
            self.assertIn("--network full", command)
            self.assertIn("--run-deadline-sec 700", command)
            self.assertEqual(kwargs["timeout_sec"], 720)

    async def test_needs_input_is_not_collapsed_into_agent_failure(self):
        module = import_portable_agent_module()
        with TemporaryDirectory() as tmp:
            async def exec_side_effect(command, **kwargs):
                if "/usr/local/bin/agent run" in command:
                    return SimpleNamespace(
                        return_code=2,
                        stdout=json.dumps({"kind": "result", "result": {
                            "status": "needs_input", "message": "external input required"
                        }}) + "\n",
                        stderr=""
                    )
                if command.startswith("test -f ") or command.startswith("test -d "):
                    return SimpleNamespace(return_code=1, stdout="", stderr="")
                return SimpleNamespace(return_code=0, stdout="", stderr="")

            env = SimpleNamespace(
                exec=AsyncMock(side_effect=exec_side_effect),
                upload_file=AsyncMock(),
                upload_dir=AsyncMock(),
                download_file=AsyncMock(),
            )
            context = SimpleNamespace(task_id="needs-input")
            agent = module.SigmaCliHarborAgent(logs_dir=Path(tmp) / "logs")
            agent._workspace = "/app"

            with self.assertRaisesRegex(RuntimeError, "^needs_input:"):
                await agent.run("run", env, context)
            self.assertEqual(context.failure_kind, "needs_input")
            self.assertIn("external input required", context.error_message)

    def test_agent_process_group_wrapper_waits_for_the_real_agent(self):
        module = import_portable_agent_module()
        agent = module.SigmaCliHarborAgent()
        wrapped = agent._agent_command_with_process_record(["/usr/local/bin/agent", "run"])

        self.assertIn("setsid --wait /bin/sh", wrapped)
        self.assertIn("setsid --help", wrapped)
        self.assertIn("grep -q -- '--wait'", wrapped)
        self.assertIn("else exec /bin/sh", wrapped)

    async def test_durable_run_failure_is_agent_failure_and_keeps_model_diagnostics(self):
        module = import_portable_agent_module()
        with TemporaryDirectory() as tmp:
            logs_dir = Path(tmp) / "logs"
            diagnostics = {
                "provider": "provider-a",
                "model": "model-a",
                "category": "protocol",
                "httpStatus": 200,
                "doneReceived": False,
                "transportEnded": True,
                "lastEventType": "reasoning",
                "hasContent": False,
                "hasReasoning": True,
                "hasToolCall": False,
                "retryAttempts": 1,
                "sseChunks": 1,
                "sseBytes": 64,
                "sseFrames": 1,
                "ssePayloads": 1,
                "sseTrailingBytes": 0,
            }
            events = [
                {"kind": "event", "event": {
                    "eventId": "model-failure",
                    "sessionId": "failure-session",
                    "runId": "failure-run",
                    "seq": 1,
                    "type": "model.failed",
                    "payload": {
                        "turnId": 1,
                        "effectRevision": 1,
                        "code": "model_stream_protocol_error",
                        "message": "stream ended before terminal marker",
                        "diagnostics": diagnostics,
                    },
                }},
                {"kind": "event", "event": {
                    "eventId": "run-failure",
                    "sessionId": "failure-session",
                    "runId": "failure-run",
                    "seq": 2,
                    "type": "run.failed",
                    "payload": {
                        "kind": "recoverable_failure",
                        "code": "model_stream_protocol_error",
                        "message": "stream ended before terminal marker",
                    },
                }},
            ]
            stdout = "\n".join([
                *(json.dumps(event) for event in events),
                json.dumps({"kind": "result", "result": {
                    "status": "error",
                    "finishReason": "recoverable_failure",
                    "sessionId": "failure-session",
                    "finalMessage": "stream ended before terminal marker",
                }}),
            ]) + "\n"

            async def exec_side_effect(command, **kwargs):
                if "/usr/local/bin/agent run" in command:
                    return SimpleNamespace(return_code=1, stdout=stdout, stderr="")
                if command.startswith("test -f ") or command.startswith("test -d "):
                    return SimpleNamespace(return_code=1, stdout="", stderr="")
                return SimpleNamespace(return_code=0, stdout="", stderr="")

            env = SimpleNamespace(
                exec=AsyncMock(side_effect=exec_side_effect),
                upload_file=AsyncMock(),
                download_file=AsyncMock(),
            )
            context = SimpleNamespace(task_id="durable-failure")
            agent = module.SigmaCliHarborAgent(logs_dir=logs_dir)
            agent._workspace = "/app"

            with self.assertRaisesRegex(RuntimeError, "^agent_failure:"):
                await agent.run("run", env, context)

            self.assertEqual(context.failure_kind, "agent_failure")
            summary = json.loads((logs_dir / "summary.json").read_text(encoding="utf-8"))
            self.assertEqual(summary["model_failure"]["code"], "model_stream_protocol_error")
            self.assertEqual(summary["model_failure"]["diagnostics"], diagnostics)
            trace = [
                json.loads(line)
                for line in (logs_dir / "trace.jsonl").read_text(encoding="utf-8").splitlines()
            ]
            self.assertEqual([record["type"] for record in trace], ["model_end", "run_end"])
            self.assertEqual(trace[0]["metadata"]["diagnostics"], diagnostics)

    async def test_terminal_model_and_tool_errors_keep_distinct_categories(self):
        module = import_portable_agent_module()
        for event_type, expected in (("model.failed", "api_error"), ("tool.failed", "tool_error")):
            with self.subTest(event_type=event_type), TemporaryDirectory() as tmp:
                event = {"kind": "event", "event": {
                    "eventId": event_type,
                    "sessionId": "failure-session",
                    "seq": 1,
                    "type": event_type,
                    "payload": {"message": "failure"},
                }}

                async def exec_side_effect(command, **kwargs):
                    if "/usr/local/bin/agent run" in command:
                        return SimpleNamespace(
                            return_code=1,
                            stdout="\n".join([
                                json.dumps(event),
                                json.dumps({"kind": "result", "result": {"status": "failed", "message": "failure"}}),
                            ]) + "\n",
                            stderr="",
                        )
                    if command.startswith("test -f ") or command.startswith("test -d "):
                        return SimpleNamespace(return_code=1, stdout="", stderr="")
                    return SimpleNamespace(return_code=0, stdout="", stderr="")

                env = SimpleNamespace(
                    exec=AsyncMock(side_effect=exec_side_effect),
                    upload_file=AsyncMock(),
                    upload_dir=AsyncMock(),
                    download_file=AsyncMock(),
                )
                context = SimpleNamespace(task_id="failure-category")
                agent = module.SigmaCliHarborAgent(logs_dir=Path(tmp) / "logs")
                agent._workspace = "/app"
                with self.assertRaisesRegex(RuntimeError, f"^{expected}:"):
                    await agent.run("run", env, context)
                self.assertEqual(context.failure_kind, expected)

    async def test_runtime_terminal_failures_keep_v4_categories(self):
        module = import_portable_agent_module()
        agent = module.SigmaCliHarborAgent(logs_dir=Path("unused"))
        cases = (
            ("convergence_no_progress", {}, "convergence_no_progress"),
            ("validation_failed", {}, "validation_blocked"),
            ("runtime_terminal_missing", {}, "runtime_invariant_failure"),
            ("model_stream_protocol_error", {"diagnostics": {"category": "protocol"}}, "agent_failure"),
            ("model_route_failed", {"diagnostics": {"category": "rate_limit"}}, "api_error"),
        )
        for code, extra, expected in cases:
            with self.subTest(code=code):
                payload = {"code": code, **extra}
                actual = agent._failure_kind_from_events(
                    [{"type": "run.failed", "payload": payload}],
                    {"status": "failed"},
                )
                self.assertEqual(actual, expected)

    async def test_timeout_persists_bounded_partial_outputs_and_trace_state(self):
        module = import_portable_agent_module()
        with TemporaryDirectory() as tmp:
            class TimeoutWithOutput(TimeoutError):
                stdout = '{"kind":"event","event":{"type":"tool.started"}}\n'
                stderr = "partial broker stderr"

            async def exec_side_effect(command, **kwargs):
                if "/usr/local/bin/agent run" in command:
                    raise TimeoutWithOutput("deadline exceeded")
                if command.startswith("test -f ") or command.startswith("test -d "):
                    return SimpleNamespace(return_code=1, stdout="", stderr="")
                return SimpleNamespace(return_code=0, stdout="", stderr="")

            env = SimpleNamespace(
                exec=AsyncMock(side_effect=exec_side_effect),
                upload_file=AsyncMock(),
                upload_dir=AsyncMock(),
                download_file=AsyncMock(),
            )
            logs_dir = Path(tmp) / "logs"
            context = SimpleNamespace(task_id="timeout")
            agent = module.SigmaCliHarborAgent(logs_dir=logs_dir, network_mode="none")
            agent._workspace = "/app"

            with self.assertRaisesRegex(RuntimeError, "^timeout:"):
                await agent.run("run", env, context)

            summary = json.loads((logs_dir / "summary.json").read_text(encoding="utf-8"))
            timeout_state = json.loads((logs_dir / "timeout.json").read_text(encoding="utf-8"))
            trace = (logs_dir / "trace.jsonl").read_text(encoding="utf-8")
            self.assertEqual(context.failure_kind, "timeout")
            self.assertEqual(summary["failure_kind"], "timeout")
            self.assertTrue(timeout_state["timed_out"])
            self.assertIn("run_timeout", trace)
            self.assertIn("partial broker stderr", (logs_dir / "stderr.partial.log").read_text(encoding="utf-8"))

    async def test_run_has_no_legacy_controller_flags_by_default(self):
        module = import_portable_agent_module()
        with TemporaryDirectory() as tmp:
            exec_commands = []

            async def exec_side_effect(command, **kwargs):
                exec_commands.append((command, kwargs))
                if "/usr/local/bin/agent run" in command:
                    return SimpleNamespace(
                        return_code=0,
                        stdout=completed_stream("no-legacy-flags"),
                        stderr="",
                    )
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
            async def exec_side_effect(command, **kwargs):
                if "/usr/local/bin/agent run" in command:
                    return SimpleNamespace(return_code=0, stdout=completed_stream("session"), stderr="")
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
                    "reasoningTokens": 6,
                    "cacheReadTokens": 3,
                    "cacheWriteTokens": 2,
                    "costMicroUsd": 19,
                })),
                json.dumps(event(3, "model.completed", {"finishReason": "length"})),
                json.dumps(event(4, "diagnostic", {"kind": "deadline.stage", "stage": "converge"})),
                json.dumps(event(5, "tool.requested", {"callId": "tool-1", "name": "execute"})),
                json.dumps(event(6, "tool.completed", {"callId": "tool-1", "name": "execute"})),
                json.dumps(event(7, "run.completed", {
                    "kind": "completed", "message": "done", "evidence": []
                })),
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
            self.assertEqual(context.n_cache_read_tokens, 3)
            self.assertEqual(context.n_reasoning_tokens, 6)
            self.assertEqual(context.length_finish_count, 1)
            self.assertEqual(context.converge_turns, 1)
            self.assertEqual(context.model_turns, 1)
            self.assertEqual(context.tool_calls, 1)
            summary = json.loads((logs_dir / "summary.json").read_text(encoding="utf-8"))
            self.assertEqual(summary["input_tokens"], 11)
            self.assertEqual(summary["reasoning_tokens"], 6)
            self.assertEqual(summary["cache_read_ratio"], 3 / 11)
            self.assertEqual(summary["reasoning_output_ratio"], 6 / 7)
            self.assertEqual(summary["length_finish_count"], 1)
            self.assertEqual(summary["converge_turns"], 1)
            self.assertEqual(summary["model_turns"], 1)
            trace_types = [
                json.loads(line)["type"]
                for line in (logs_dir / "trace.jsonl").read_text(encoding="utf-8").splitlines()
            ]
            self.assertIn("usage", trace_types)
            self.assertIn("tool_end", trace_types)
            self.assertIn("run_end", trace_types)

    async def test_zero_exit_without_terminal_event_or_result_is_agent_protocol_failure(self):
        module = import_portable_agent_module()
        with TemporaryDirectory() as tmp:
            logs_dir = Path(tmp) / "logs"
            event = lambda seq, event_type, payload: {
                "kind": "event",
                "event": {
                    "eventId": f"event-{seq}",
                    "sessionId": "incomplete-session",
                    "runId": "incomplete-run",
                    "seq": seq,
                    "type": event_type,
                    "payload": payload,
                },
            }
            stdout = "\n".join([
                json.dumps(event(1, "model.started", {
                    "provider": "provider-a", "model": "model-a", "turnId": 1
                })),
                json.dumps(event(2, "model.reasoning_delta", {
                    "turnId": 1, "delta": "partial reasoning"
                })),
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
            context = SimpleNamespace(task_id="incomplete-protocol")
            agent = module.SigmaCliHarborAgent(logs_dir=logs_dir)
            agent._workspace = "/app"

            with self.assertRaisesRegex(RuntimeError, "agent_failure: agent protocol incomplete"):
                await agent.run("run", env, context)

            self.assertEqual(context.exit_code, 1)
            self.assertEqual(context.failure_kind, "agent_failure")
            self.assertIn("last_event_type=model.reasoning_delta", context.error_message)
            summary = json.loads((logs_dir / "summary.json").read_text(encoding="utf-8"))
            self.assertEqual(summary["status"], "error")
            self.assertEqual(summary["finish_reason"], "agent_protocol_incomplete")
            self.assertEqual(summary["failure_kind"], "agent_failure")
            self.assertEqual(summary["protocol_failure"]["provider"], "provider-a")
            self.assertEqual(summary["protocol_failure"]["model"], "model-a")
            self.assertFalse(summary["protocol_failure"]["has_content"])
            self.assertTrue(summary["protocol_failure"]["has_reasoning"])
            self.assertFalse(summary["protocol_failure"]["has_tool_call"])

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
                        "payload": {"kind": "completed", "message": "done", "evidence": []},
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
                if "/usr/local/bin/agent run" in command:
                    return SimpleNamespace(
                        return_code=0,
                        stdout=completed_stream("reviewer-waiver"),
                        stderr="",
                    )
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

    async def test_streamed_output_callback_persists_incremental_accounting(self):
        module = import_portable_agent_module()
        with TemporaryDirectory() as tmp:
            logs_dir = Path(tmp) / "logs"
            active_callback = None
            event = {
                "kind": "event",
                "event": {
                    "eventId": "callback-event",
                    "sessionId": "callback-session",
                    "seq": 1,
                    "type": "model.started",
                    "payload": {"turnId": 1},
                },
            }
            completed_event = {
                "kind": "event",
                "event": {
                    "eventId": "callback-completed",
                    "sessionId": "callback-session",
                    "seq": 3,
                    "type": "run.completed",
                    "payload": {"kind": "completed", "message": "done", "evidence": []},
                },
            }
            result = {"kind": "result", "result": {
                "status": "completed",
                "finishReason": "completed",
                "sessionId": "callback-session",
            }}

            @contextlib.contextmanager
            def scoped_output_callback(callback):
                nonlocal active_callback
                previous = active_callback
                active_callback = callback
                try:
                    yield
                finally:
                    active_callback = previous

            async def exec_side_effect(command, **kwargs):
                if "/usr/local/bin/agent run" in command:
                    await active_callback(json.dumps(event)[:25], "stdout")
                    await active_callback(json.dumps(event)[25:] + "\n", "stdout")
                    await active_callback(json.dumps({
                        "kind": "event",
                        "event": {
                            **event["event"],
                            "eventId": "callback-usage",
                            "seq": 2,
                            "type": "usage.recorded",
                            "payload": {"inputTokens": 3, "outputTokens": 2},
                        },
                    }) + "\n", "stdout")
                    await active_callback(json.dumps(completed_event) + "\n", "stdout")
                    await active_callback(json.dumps(result) + "\n", "stdout")
                    return SimpleNamespace(return_code=0, stdout="", stderr="")
                if command.startswith("test -f ") or command.startswith("test -d "):
                    return SimpleNamespace(return_code=1, stdout="", stderr="")
                return SimpleNamespace(return_code=0, stdout="", stderr="")

            env = SimpleNamespace(
                exec=AsyncMock(side_effect=exec_side_effect),
                scoped_output_callback=scoped_output_callback,
                upload_file=AsyncMock(),
                download_file=AsyncMock(),
            )
            context = SimpleNamespace(task_id="callback")
            agent = module.SigmaCliHarborAgent(logs_dir=logs_dir)
            agent._workspace = "/app"

            await agent.run("run", env, context)

            self.assertEqual(context.model_turns, 1)
            self.assertEqual(context.n_input_tokens, 3)
            self.assertEqual(context.n_output_tokens, 2)
            self.assertIn("model_start", (logs_dir / "trace.jsonl").read_text(encoding="utf-8"))
            self.assertTrue((logs_dir / "stdout.partial.log").is_file())

    async def test_cancelled_run_persists_timeout_artifacts_before_reraising(self):
        module = import_portable_agent_module()
        with TemporaryDirectory() as tmp:
            logs_dir = Path(tmp) / "logs"
            commands = []

            async def exec_side_effect(command, **kwargs):
                commands.append(command)
                if "/usr/local/bin/agent run" in command:
                    raise asyncio.CancelledError()
                if "agent-process.json" in command:
                    return SimpleNamespace(
                        return_code=0,
                        stdout='{"pid_recorded":true,"pid":42,"pgid":42,"status":"terminated"}\n',
                        stderr="",
                    )
                if command.startswith("test -f ") or command.startswith("test -d "):
                    return SimpleNamespace(return_code=1, stdout="", stderr="")
                return SimpleNamespace(return_code=0, stdout="", stderr="")

            env = SimpleNamespace(
                exec=AsyncMock(side_effect=exec_side_effect),
                upload_file=AsyncMock(),
                download_file=AsyncMock(),
            )
            context = SimpleNamespace(task_id="cancelled")
            agent = module.SigmaCliHarborAgent(
                logs_dir=logs_dir,
                max_wall_time_sec=200,
                agent_timeout_grace_sec=30,
                outer_trial_deadline_sec=100,
            )
            agent._workspace = "/app"

            with self.assertRaises(asyncio.CancelledError):
                await agent.run("run", env, context)

            self.assertEqual(agent.max_wall_time_sec, 70)
            self.assertEqual(context.failure_kind, "timeout")
            for filename in ("timeout.json", "summary.json", "trace.jsonl", "stdout.partial.log", "stderr.partial.log"):
                self.assertTrue((logs_dir / filename).is_file(), filename)
            timeout_state = json.loads((logs_dir / "timeout.json").read_text(encoding="utf-8"))
            self.assertEqual(timeout_state["process_cleanup"]["pid"], 42)
            self.assertIn("kill -TERM", "\n".join(commands))
            self.assertIn("kill -KILL", "\n".join(commands))
            self.assertNotIn("pkill", "\n".join(commands))

    async def test_outer_cancel_preserves_recorded_needs_input_terminal_state(self):
        module = import_portable_agent_module()
        with TemporaryDirectory() as tmp:
            logs_dir = Path(tmp) / "logs"
            active_callback = None

            @contextlib.contextmanager
            def scoped_output_callback(callback):
                nonlocal active_callback
                active_callback = callback
                try:
                    yield
                finally:
                    active_callback = None

            async def exec_side_effect(command, **kwargs):
                if "/usr/local/bin/agent run" in command:
                    await active_callback(json.dumps({
                        "kind": "event",
                        "event": {
                            "eventId": "suspended-event",
                            "sessionId": "suspended-session",
                            "seq": 1,
                            "type": "run.suspended",
                            "payload": {"requestId": "approval", "message": "approval unavailable"},
                        },
                    }) + "\n", "stdout")
                    await active_callback(json.dumps({
                        "kind": "result",
                        "result": {
                            "status": "needs_input",
                            "sessionId": "suspended-session",
                            "message": "approval unavailable",
                        },
                    }) + "\n", "stdout")
                    raise asyncio.CancelledError()
                if "agent-process.json" in command:
                    return SimpleNamespace(
                        return_code=0,
                        stdout='{"pid_recorded":true,"pid":42,"pgid":42,"status":"terminated"}\n',
                        stderr="",
                    )
                if command.startswith("test -f ") or command.startswith("test -d "):
                    return SimpleNamespace(return_code=1, stdout="", stderr="")
                return SimpleNamespace(return_code=0, stdout="", stderr="")

            env = SimpleNamespace(
                exec=AsyncMock(side_effect=exec_side_effect),
                scoped_output_callback=scoped_output_callback,
                upload_file=AsyncMock(),
                download_file=AsyncMock(),
            )
            context = SimpleNamespace(task_id="recorded-terminal")
            agent = module.SigmaCliHarborAgent(logs_dir=logs_dir)
            agent._workspace = "/app"

            with self.assertRaisesRegex(RuntimeError, "^needs_input:"):
                await agent.run("run", env, context)

            summary = json.loads((logs_dir / "summary.json").read_text(encoding="utf-8"))
            self.assertEqual(context.failure_kind, "needs_input")
            self.assertEqual(summary["failure_kind"], "needs_input")
            self.assertEqual(summary["terminal_origin"], "runtime_result")
            self.assertGreater(summary["duration_ms"], 0)
            self.assertNotEqual(summary.get("terminal_origin"), "adapter_timeout")

    def test_stream_accounting_counts_each_tool_call_once(self):
        module = import_portable_agent_module()
        with TemporaryDirectory() as tmp:
            recorder = module._OutputRecorder(Path(tmp) / "logs")
            for seq, event_type in enumerate(("tool.requested", "tool.started"), start=1):
                recorder.record(json.dumps({
                    "kind": "event",
                    "event": {
                        "eventId": f"tool-{seq}",
                        "sessionId": "session",
                        "seq": seq,
                        "type": event_type,
                        "payload": {"callId": "call"},
                    },
                }) + "\n", "stdout")

            self.assertEqual(recorder.snapshot()["tool_calls"], 1)

    async def test_partial_logs_are_bounded(self):
        module = import_portable_agent_module()
        with TemporaryDirectory() as tmp:
            recorder = module._OutputRecorder(Path(tmp) / "logs")
            recorder.record("x" * (module.MAX_PARTIAL_ARTIFACT_CHARS + 100), "stdout")
            recorder.record("y" * (module.MAX_PARTIAL_ARTIFACT_CHARS + 100), "stderr")
            self.assertLessEqual(
                (recorder.stdout_path).stat().st_size,
                module.MAX_PARTIAL_ARTIFACT_CHARS,
            )
            self.assertLessEqual(
                (recorder.stderr_path).stat().st_size,
                module.MAX_PARTIAL_ARTIFACT_CHARS,
            )

    async def test_incremental_trace_is_bounded_and_keeps_tail(self):
        module = import_portable_agent_module()
        with TemporaryDirectory() as tmp:
            trace_path = Path(tmp) / "trace.jsonl"
            for index in range(20):
                module._append_bounded_jsonl(trace_path, {"type": "event", "seq": index, "payload": "z" * 40}, 256)
            self.assertLessEqual(trace_path.stat().st_size, 256)
            trace_lines = trace_path.read_text(encoding="utf-8").splitlines()
            self.assertTrue(any(json.loads(line).get("type") == "trace_truncated" for line in trace_lines))
            self.assertEqual(json.loads(trace_lines[-1]).get("seq"), 19)


if __name__ == "__main__":
    unittest.main()
