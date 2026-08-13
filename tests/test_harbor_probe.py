import asyncio
import subprocess
import unittest
from pathlib import Path

from scripts.harbor_task_download_retry import download_git_tasks_with_retry


class HarborProbeRetryTest(unittest.TestCase):
    def test_retries_transient_clone_without_retrying_other_git_failures(self) -> None:
        calls = []
        delays = []

        async def original(_client, _url, _configs):
            calls.append(len(calls) + 1)
            if len(calls) < 3:
                raise subprocess.CalledProcessError(128, ["git", "clone"])
            return {Path("task"): "a" * 40}

        async def sleep(delay):
            delays.append(delay)

        result = asyncio.run(download_git_tasks_with_retry(
            object(), original, "https://example.test/repo.git", [], sleep=sleep
        ))
        self.assertEqual(result, {Path("task"): "a" * 40})
        self.assertEqual(calls, [1, 2, 3])
        self.assertEqual(delays, [1, 2])

        async def checkout_failure(_client, _url, _configs):
            raise subprocess.CalledProcessError(1, ["git", "checkout"])

        with self.assertRaises(subprocess.CalledProcessError):
            asyncio.run(download_git_tasks_with_retry(
                object(), checkout_failure, "https://example.test/repo.git", [], sleep=sleep
            ))
        self.assertEqual(delays, [1, 2])


if __name__ == "__main__":
    unittest.main()
