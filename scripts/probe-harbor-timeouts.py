#!/usr/bin/env python3
"""Resolve Harbor tasks and print their recommended timeout metadata as JSON."""

from __future__ import annotations

import asyncio
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

from harbor.job import Job
from harbor.models.job.config import JobConfig
from harbor.models.task.config import TaskConfig as TaskDefinitionConfig
from harbor.models.task.paths import TaskPaths


def _number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def _task_name(trial_task_config: Any, task_definition: TaskDefinitionConfig | None) -> str:
    task_info = getattr(task_definition, "task", None)
    name = getattr(task_info, "name", None)
    if isinstance(name, str) and name:
        return name

    name = getattr(trial_task_config, "name", None)
    if isinstance(name, str) and name:
        return name

    path = getattr(trial_task_config, "path", None)
    return str(path) if path is not None else "unknown"


def _trial_task_identity(trial_task_config: Any) -> dict[str, Any]:
    try:
        dumped = trial_task_config.model_dump(mode="json", exclude_none=True)
    except Exception:
        return {}
    return {
        key: dumped.get(key)
        for key in ["name", "path", "git_url", "git_commit_id", "source"]
        if dumped.get(key) is not None
    }


def _effective_agent_network(task_definition: TaskDefinitionConfig | None) -> str | None:
    if task_definition is None:
        return None
    baseline = task_definition.environment.resolve_baseline()
    policy = task_definition.agent.explicit_phase_policy() or baseline
    return policy.network_mode.value


def _timeout_record(trial_task_config: Any, task_path: Path | None) -> dict[str, Any]:
    task_definition: TaskDefinitionConfig | None = None
    config_path = TaskPaths(task_path).config_path if task_path is not None else None
    config_bytes: bytes | None = None
    if config_path is not None and config_path.is_file():
        config_bytes = config_path.read_bytes()
        task_definition = TaskDefinitionConfig.model_validate_toml(config_bytes.decode("utf-8"))

    metadata = task_definition.metadata if task_definition is not None else {}
    return {
        "task_name": _task_name(trial_task_config, task_definition),
        "task_path": str(task_path) if task_path is not None else None,
        "task_toml_path": str(config_path) if config_path is not None else None,
        "task_identity": _trial_task_identity(trial_task_config),
        "task_config_sha256": hashlib.sha256(config_bytes).hexdigest() if config_bytes else None,
        "effective_agent_network_mode": _effective_agent_network(task_definition),
        "agent_timeout_sec": (
            _number(task_definition.agent.timeout_sec) if task_definition is not None else None
        ),
        "verifier_timeout_sec": (
            _number(task_definition.verifier.timeout_sec) if task_definition is not None else None
        ),
        "environment_build_timeout_sec": (
            _number(task_definition.environment.build_timeout_sec) if task_definition is not None else None
        ),
        "expert_time_estimate_min": _number(metadata.get("expert_time_estimate_min")),
        "junior_time_estimate_min": _number(metadata.get("junior_time_estimate_min")),
    }


def _resolved_task_config(trial_task_config: Any, record: dict[str, Any]) -> dict[str, Any]:
    name = record.get("task_name")
    if isinstance(name, str) and name and name != "unknown":
        return {"name": name}

    try:
        dumped = trial_task_config.model_dump(mode="json", exclude_none=True)
        if isinstance(dumped, dict):
            for key in ["name", "path", "git_url", "git_commit_id", "ref", "source"]:
                value = dumped.get(key)
                if value:
                    return {key: value}
    except Exception:
        pass

    path_value = record.get("task_path")
    if isinstance(path_value, str) and path_value:
        return {"path": path_value}
    return {"name": str(name or "unknown")}


def _max_number(records: list[dict[str, Any]], key: str) -> float | None:
    values = [value for record in records if isinstance((value := record.get(key)), (int, float))]
    return max(values) if values else None


async def _main(config_path: Path) -> None:
    config_bytes = config_path.read_bytes()
    config = JobConfig.model_validate_json(config_bytes.decode("utf-8-sig"))
    job = await Job.create(config)

    records: list[dict[str, Any]] = []
    resolved_tasks: list[dict[str, Any]] = []
    for trial_task_config in job._task_configs:
        task_path: Path | None = None
        download_result = job._task_download_results.get(trial_task_config.get_task_id())
        if download_result is not None:
            task_path = Path(download_result.path)
        else:
            try:
                task_path = trial_task_config.get_local_path()
            except Exception:
                task_path = None
        record = _timeout_record(trial_task_config, task_path)
        records.append(record)
        resolved_tasks.append(_resolved_task_config(trial_task_config, record))

    print(
        json.dumps(
            {
                "schemaVersion": 1,
                "kind": "sigma.harbor-resolved-task-attestation",
                "job_config_sha256": hashlib.sha256(config_bytes).hexdigest(),
                "tasks": records,
                "max_agent_timeout_sec": _max_number(records, "agent_timeout_sec"),
                "max_verifier_timeout_sec": _max_number(records, "verifier_timeout_sec"),
                "max_environment_build_timeout_sec": _max_number(
                    records, "environment_build_timeout_sec"
                ),
                "resolved_tasks": resolved_tasks,
            },
            ensure_ascii=False,
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: probe-harbor-timeouts.py <job-config-json>", file=sys.stderr)
        raise SystemExit(2)
    asyncio.run(_main(Path(sys.argv[1])))
