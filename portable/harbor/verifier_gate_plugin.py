"""Cross-process verifier concurrency gate for Harbor jobs.

The gate is intentionally workload-neutral: it uses only run-scoped process
configuration and Harbor's opaque trial UUID. It never inspects task identity,
agent output, verifier output, rewards, or retry state.
"""

from __future__ import annotations

import asyncio
import atexit
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import BinaryIO

from harbor.models.job.plugin import BaseJobPlugin


class _FilePermit:
    def __init__(self, slot: int, handle: BinaryIO) -> None:
        self.slot = slot
        self.handle = handle

    def release(self) -> None:
        try:
            self.handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(self.handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(self.handle.fileno(), fcntl.LOCK_UN)
        finally:
            self.handle.close()


def _try_lock(path: Path, slot: int) -> _FilePermit | None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open("a+b")
    try:
        if path.stat().st_size == 0:
            handle.write(b"\0")
            handle.flush()
        handle.seek(0)
        if os.name == "nt":
            import msvcrt

            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return _FilePermit(slot, handle)
    except (BlockingIOError, OSError):
        handle.close()
        return None
    except BaseException:
        handle.close()
        raise


def _verifier_timings(result: object) -> list[object]:
    timings: list[object] = []
    direct = getattr(result, "verifier", None)
    if direct is not None:
        timings.append(direct)
    step_results = getattr(result, "step_results", None) or []
    for step_result in step_results:
        timing = getattr(step_result, "verifier", None)
        if timing is not None:
            timings.append(timing)
    return timings


def _active_verifier_timing(result: object) -> object | None:
    return next(
        (
            timing
            for timing in reversed(_verifier_timings(result))
            if getattr(timing, "finished_at", None) is None
        ),
        None,
    )


class VerifierGatePlugin(BaseJobPlugin):
    """Bound concurrent verifier phases across independent Harbor processes."""

    def __init__(self, **_kwargs: object) -> None:
        run_dir_text = os.environ.get("SIGMA_BENCH_RUN_DIR", "").strip()
        if not run_dir_text:
            raise ValueError("SIGMA_BENCH_RUN_DIR is required for the verifier gate")
        limit_text = os.environ.get("SIGMA_VERIFIER_CONCURRENCY", "").strip()
        try:
            self._limit = int(limit_text)
        except ValueError as error:
            raise ValueError("SIGMA_VERIFIER_CONCURRENCY must be an integer") from error
        if self._limit < 1 or self._limit > 64:
            raise ValueError("SIGMA_VERIFIER_CONCURRENCY must be between 1 and 64")

        poll_text = os.environ.get("SIGMA_VERIFIER_GATE_POLL_MS", "50").strip()
        try:
            poll_ms = int(poll_text)
        except ValueError as error:
            raise ValueError("SIGMA_VERIFIER_GATE_POLL_MS must be an integer") from error
        if poll_ms < 5 or poll_ms > 1000:
            raise ValueError("SIGMA_VERIFIER_GATE_POLL_MS must be between 5 and 1000")

        run_dir = Path(run_dir_text).resolve()
        scratch_dir = run_dir / "runtime-scratch" / "verifier-gate"
        self._locks_dir = scratch_dir / "locks"
        events_dir = scratch_dir / "events"
        self._locks_dir.mkdir(parents=True, exist_ok=True)
        events_dir.mkdir(parents=True, exist_ok=True)
        run_slot = os.environ.get("SIGMA_BENCH_RUN_SLOT", "slot")
        safe_slot = "".join(
            character if character.isalnum() or character in "._-" else "-"
            for character in run_slot
        ).strip("-") or "slot"
        self._events_path = events_dir / f"{safe_slot}-{os.getpid()}.jsonl"
        self._poll_seconds = poll_ms / 1000
        self._held: dict[str, tuple[_FilePermit, int]] = {}
        self._watchers: dict[str, asyncio.Task[None]] = {}
        atexit.register(self._release_all_sync)

    async def on_job_start(self, job) -> None:
        job.on_verification_started(self._acquire)
        job.on_trial_ended(self._release)
        job.on_trial_cancelled(self._release)

    async def on_job_end(self, _job_result) -> None:
        self._release_all_sync(reason="job_end")
        watchers = list(self._watchers.values())
        for watcher in watchers:
            watcher.cancel()
        if watchers:
            await asyncio.gather(*watchers, return_exceptions=True)

    def _write_event(self, payload: dict[str, object]) -> None:
        record = {
            "schemaVersion": 1,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            **payload,
        }
        try:
            with self._events_path.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(record, separators=(",", ":"), sort_keys=True))
                stream.write("\n")
        except OSError:
            # Telemetry must never weaken the concurrency guarantee.
            pass

    async def _acquire(self, event) -> None:
        trial_id = str(event.trial_id)
        if trial_id in self._held:
            return
        started_ns = time.monotonic_ns()
        contended = False
        while True:
            for slot in range(self._limit):
                permit = _try_lock(self._locks_dir / f"slot-{slot}.lock", slot)
                if permit is None:
                    continue
                acquired_ns = time.monotonic_ns()
                self._held[trial_id] = (permit, acquired_ns)
                self._write_event(
                    {
                        "event": "acquired",
                        "trial_id": trial_id,
                        "gate_slot": slot,
                        "wait_ms": round((acquired_ns - started_ns) / 1_000_000, 3),
                        "contended": contended,
                    }
                )
                result = getattr(event, "result", None)
                timing = _active_verifier_timing(result)
                known_timing_ids = {id(item) for item in _verifier_timings(result)}
                self._watchers[trial_id] = asyncio.create_task(
                    self._release_when_verifier_finishes(
                        event, trial_id, timing, known_timing_ids
                    )
                )
                return
            contended = True
            await asyncio.sleep(self._poll_seconds)

    async def _release(self, event) -> None:
        trial_id = str(event.trial_id)
        self._release_trial(trial_id, reason="trial_end")
        watcher = self._watchers.pop(trial_id, None)
        if watcher is not None and watcher is not asyncio.current_task():
            watcher.cancel()
            await asyncio.gather(watcher, return_exceptions=True)

    async def _release_when_verifier_finishes(
        self,
        event,
        trial_id: str,
        timing: object | None,
        known_timing_ids: set[int],
    ) -> None:
        try:
            while trial_id in self._held:
                result = getattr(event, "result", None)
                if timing is None:
                    timing = next(
                        (
                            item
                            for item in reversed(_verifier_timings(result))
                            if id(item) not in known_timing_ids
                        ),
                        None,
                    )
                if timing is not None and getattr(timing, "finished_at", None) is not None:
                    self._release_trial(trial_id, reason="verifier_finished")
                    return
                await asyncio.sleep(min(self._poll_seconds, 0.05))
        finally:
            self._watchers.pop(trial_id, None)

    def _release_trial(self, trial_id: str, *, reason: str) -> None:
        held = self._held.pop(trial_id, None)
        if held is None:
            return
        permit, acquired_ns = held
        held_ms = round((time.monotonic_ns() - acquired_ns) / 1_000_000, 3)
        slot = permit.slot
        try:
            permit.release()
        finally:
            self._write_event(
                {
                    "event": "released",
                    "trial_id": trial_id,
                    "gate_slot": slot,
                    "held_ms": held_ms,
                    "reason": reason,
                }
            )

    def _release_all_sync(self, *, reason: str = "process_exit") -> None:
        for trial_id in list(self._held):
            self._release_trial(trial_id, reason=reason)
