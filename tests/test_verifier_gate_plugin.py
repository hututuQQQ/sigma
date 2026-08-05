import asyncio
import importlib
import json
import os
import sys
import types
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch


def import_verifier_gate_module():
    for name in ("harbor", "harbor.models", "harbor.models.job"):
        module = types.ModuleType(name)
        module.__path__ = []
        sys.modules[name] = module
    plugin_module = types.ModuleType("harbor.models.job.plugin")
    plugin_module.BaseJobPlugin = type("BaseJobPlugin", (), {})
    sys.modules["harbor.models.job.plugin"] = plugin_module
    sys.modules.pop("portable.harbor.verifier_gate_plugin", None)
    return importlib.import_module("portable.harbor.verifier_gate_plugin")


class FakeJob:
    def __init__(self):
        self.verification_started = None
        self.trial_ended = None
        self.trial_cancelled = None

    def on_verification_started(self, callback):
        self.verification_started = callback

    def on_trial_ended(self, callback):
        self.trial_ended = callback

    def on_trial_cancelled(self, callback):
        self.trial_cancelled = callback


class VerifierGatePluginTests(unittest.IsolatedAsyncioTestCase):
    async def test_releases_when_harbor_marks_verifier_timing_finished(self):
        module = import_verifier_gate_module()
        with TemporaryDirectory(prefix="sigma-verifier-gate-finish-") as run_dir:
            with patch.dict(os.environ, {
                "SIGMA_BENCH_RUN_DIR": run_dir,
                "SIGMA_VERIFIER_CONCURRENCY": "1",
                "SIGMA_VERIFIER_GATE_POLL_MS": "5",
            }, clear=False):
                plugin = module.VerifierGatePlugin()
                result = SimpleNamespace(verifier=None)
                event = SimpleNamespace(trial_id="opaque-finished", result=result)
                await plugin._acquire(event)
                result.verifier = SimpleNamespace(finished_at=object())
                for _attempt in range(20):
                    if not plugin._held:
                        break
                    await asyncio.sleep(0.01)
                self.assertEqual(plugin._held, {})
                await plugin.on_job_end(SimpleNamespace())

            records = [
                json.loads(line)
                for event_file in (
                    Path(run_dir) / "runtime-scratch" / "verifier-gate" / "events"
                ).glob("*.jsonl")
                for line in event_file.read_text(encoding="utf-8").splitlines()
            ]
            released = next(record for record in records if record["event"] == "released")
            self.assertEqual(released["reason"], "verifier_finished")

    async def test_limits_independent_plugin_instances_and_records_neutral_events(self):
        module = import_verifier_gate_module()
        with TemporaryDirectory(prefix="sigma-verifier-gate-test-") as run_dir:
            environment = {
                "SIGMA_BENCH_RUN_DIR": run_dir,
                "SIGMA_VERIFIER_CONCURRENCY": "1",
                "SIGMA_VERIFIER_GATE_POLL_MS": "5",
            }
            with patch.dict(os.environ, environment, clear=False):
                first = module.VerifierGatePlugin()
                second = module.VerifierGatePlugin()
                first_event = SimpleNamespace(trial_id="opaque-first")
                second_event = SimpleNamespace(trial_id="opaque-second")

                await first._acquire(first_event)
                waiting = asyncio.create_task(second._acquire(second_event))
                await asyncio.sleep(0.05)
                self.assertFalse(waiting.done())

                await first._release(first_event)
                await asyncio.wait_for(waiting, timeout=1)
                await second._release(second_event)

            event_files = list(
                (Path(run_dir) / "runtime-scratch" / "verifier-gate" / "events")
                .glob("*.jsonl")
            )
            records = [
                json.loads(line)
                for event_file in event_files
                for line in event_file.read_text(encoding="utf-8").splitlines()
            ]
            self.assertEqual(sum(record["event"] == "acquired" for record in records), 2)
            self.assertTrue(any(record.get("contended") is True for record in records))
            self.assertNotIn("task_name", json.dumps(records))

    async def test_releases_each_multi_step_verifier_phase(self):
        module = import_verifier_gate_module()
        with TemporaryDirectory(prefix="sigma-verifier-gate-multistep-") as run_dir:
            with patch.dict(os.environ, {
                "SIGMA_BENCH_RUN_DIR": run_dir,
                "SIGMA_VERIFIER_CONCURRENCY": "1",
                "SIGMA_VERIFIER_GATE_POLL_MS": "5",
            }, clear=False):
                plugin = module.VerifierGatePlugin()
                first_timing = SimpleNamespace(finished_at=None)
                result = SimpleNamespace(
                    verifier=None,
                    step_results=[SimpleNamespace(verifier=first_timing)],
                )
                event = SimpleNamespace(trial_id="opaque-multistep", result=result)

                await plugin._acquire(event)
                first_timing.finished_at = object()
                for _attempt in range(20):
                    if not plugin._held:
                        break
                    await asyncio.sleep(0.01)
                self.assertEqual(plugin._held, {})

                second_timing = SimpleNamespace(finished_at=None)
                result.step_results.append(SimpleNamespace(verifier=second_timing))
                await plugin._acquire(event)
                self.assertIn("opaque-multistep", plugin._held)
                second_timing.finished_at = object()
                for _attempt in range(20):
                    if not plugin._held:
                        break
                    await asyncio.sleep(0.01)
                self.assertEqual(plugin._held, {})
                await plugin.on_job_end(SimpleNamespace())

    async def test_registers_only_lifecycle_hooks_and_releases_on_job_end(self):
        module = import_verifier_gate_module()
        with TemporaryDirectory(prefix="sigma-verifier-gate-hooks-") as run_dir:
            with patch.dict(os.environ, {
                "SIGMA_BENCH_RUN_DIR": run_dir,
                "SIGMA_VERIFIER_CONCURRENCY": "1",
            }, clear=False):
                plugin = module.VerifierGatePlugin()
                job = FakeJob()
                await plugin.on_job_start(job)
                self.assertEqual(job.verification_started, plugin._acquire)
                self.assertEqual(job.trial_ended, plugin._release)
                self.assertEqual(job.trial_cancelled, plugin._release)

                event = SimpleNamespace(trial_id="opaque-trial")
                await plugin._acquire(event)
                await plugin.on_job_end(SimpleNamespace())
                self.assertEqual(plugin._held, {})


if __name__ == "__main__":
    unittest.main()
