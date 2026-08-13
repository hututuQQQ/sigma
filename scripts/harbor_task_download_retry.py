"""Generic, pre-solver retry boundary for Harbor Git task acquisition."""

from __future__ import annotations

import asyncio
import subprocess
import sys
from typing import Any


TASK_DOWNLOAD_ATTEMPTS = 5


def retryable_git_download(error: subprocess.CalledProcessError) -> bool:
    command = [str(part).lower() for part in error.cmd]
    return len(command) >= 2 and command[0].endswith("git") and command[1] in {
        "clone",
        "fetch",
    }


async def download_git_tasks_with_retry(
    client: Any,
    original: Any,
    git_url: str,
    task_download_configs: list[Any],
    *,
    attempts: int = TASK_DOWNLOAD_ATTEMPTS,
    sleep: Any = asyncio.sleep,
) -> Any:
    for attempt in range(1, attempts + 1):
        try:
            return await original(client, git_url, task_download_configs)
        except subprocess.CalledProcessError as error:
            if attempt >= attempts or not retryable_git_download(error):
                raise
            delay = min(2 ** (attempt - 1), 8)
            print(
                f"Transient Git task download failed; retrying preflight "
                f"({attempt}/{attempts}) in {delay}s.",
                file=sys.stderr,
            )
            await sleep(delay)
    raise AssertionError("unreachable")


def install_git_task_download_retry(task_client_class: Any) -> None:
    if getattr(task_client_class, "_sigma_preflight_retry_installed", False):
        return
    original = task_client_class._download_tasks_from_git_url

    async def download_with_retry(
        client: Any,
        git_url: str,
        task_download_configs: list[Any],
    ) -> Any:
        return await download_git_tasks_with_retry(
            client,
            original,
            git_url,
            task_download_configs,
        )

    task_client_class._download_tasks_from_git_url = download_with_retry
    task_client_class._sigma_preflight_retry_installed = True
