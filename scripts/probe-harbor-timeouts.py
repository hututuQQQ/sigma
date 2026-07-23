#!/usr/bin/env python3
"""Resolve Harbor tasks and print their recommended timeout metadata as JSON."""

from __future__ import annotations

import asyncio
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


def _timeout_record(trial_task_config: Any, task_path: Path | None) -> dict[str, Any]:
    task_definition: TaskDefinitionConfig | None = None
    config_path = TaskPaths(task_path).config_path if task_path is not None else None
    if config_path is not None and config_path.is_file():
        task_definition = TaskDefinitionConfig.model_validate_toml(config_path.read_text(encoding="utf-8"))

    metadata = task_definition.metadata if task_definition is not None else {}
    network_mode = (
        getattr(task_definition.environment.network_mode, "value", task_definition.environment.network_mode)
        if task_definition is not None
        else None
    )
    return {
        "task_name": _task_name(trial_task_config, task_definition),
        "task_path": str(task_path) if task_path is not None else None,
        "task_toml_path": str(config_path) if config_path is not None else None,
        "agent_timeout_sec": (
            _number(task_definition.agent.timeout_sec) if task_definition is not None else None
        ),
        "verifier_timeout_sec": (
            _number(task_definition.verifier.timeout_sec) if task_definition is not None else None
        ),
        "environment_build_timeout_sec": (
            _number(task_definition.environment.build_timeout_sec) if task_definition is not None else None
        ),
        "network_mode": str(network_mode) if network_mode is not None else None,
        "expert_time_estimate_min": _number(metadata.get("expert_time_estimate_min")),
        "junior_time_estimate_min": _number(metadata.get("junior_time_estimate_min")),
    }


def _resolved_task_config(trial_task_config: Any, record: dict[str, Any]) -> dict[str, Any]:
    try:
        dumped = trial_task_config.model_dump(mode="json", exclude_none=True)
        if isinstance(dumped, dict):
            config_name = dumped.get("name")
            config_path = dumped.get("path")
            if isinstance(config_name, str) and config_name:
                return {"name": config_name}
            if isinstance(config_path, str) and config_path:
                resolved = {"path": config_path}
                git_url = dumped.get("git_url")
                git_commit = dumped.get("git_commit_id")
                if isinstance(git_url, str) and git_url and isinstance(git_commit, str) and git_commit:
                    resolved.update({"git_url": git_url, "git_commit_id": git_commit})
                return resolved
    except Exception:
        pass

    name = record.get("task_name")
    if isinstance(name, str) and name and name != "unknown":
        return {"name": name}
    path_value = record.get("task_path")
    if isinstance(path_value, str) and path_value:
        return {"path": path_value}
    return {"name": str(name or "unknown")}


def _max_number(records: list[dict[str, Any]], key: str) -> float | None:
    values = [value for record in records if isinstance((value := record.get(key)), (int, float))]
    return max(values) if values else None


async def _main(config_path: Path) -> None:
    config = JobConfig.model_validate_json(config_path.read_text(encoding="utf-8-sig"))
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
