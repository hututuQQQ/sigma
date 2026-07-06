# Agent Instructions

## Benchmark Fairness

Benchmark-directed programming is prohibited. Treat it as a serious integrity violation, not as an optimization.

Agents and harness code must not:

- Detect or branch on benchmark names, task IDs, task names, dataset names, verifier test names, package names, fixture names, artifact names, or known benchmark outputs.
- Add task-specific smoke tests, prechecks, prompts, retries, cleanup rules, or service behavior based on benchmark/task identity.
- Pass benchmark task identity, task hints, verifier failures, verifier traces, verifier stdout/stderr, rewards, scores, or hidden test details into the solving agent.
- Retry a solving attempt using verifier feedback or any other post-verifier information.
- Tune prompts, commands, package installs, assertions, file names, or heuristics to improve a known benchmark score instead of solving the user's stated task generally.
- Keep "dev-only" benchmark shortcuts in the default agent, harness, CLI, or portable runtime paths.

Allowed benchmark code is limited to neutral infrastructure:

- Selecting which benchmark task to run from an external runner.
- Packaging and launching the agent without exposing benchmark identity to the agent.
- Collecting logs, traces, summaries, verifier results, scores, and reports after the run for human inspection.
- Generic validation that is derived from user-provided commands, summary-declared commands, changed-file syntax checks, or broadly applicable project conventions.

When in doubt, remove benchmark-specific behavior. Prefer a lower score with a fair, reusable harness over any score gained from benchmark knowledge.
