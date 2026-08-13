# Paired Harness Experiments

The paired benchmark path compares two immutable harness runtimes while keeping the model, reasoning effort, task identity, verifier, timeout, network policy, and outer Harbor environment frozen.

It is intentionally neutral infrastructure. Task selection is an externally seeded SHA-256 ranking over a complete, Git-pinned catalog. The runner never branches on task names or verifier output, never passes benchmark identity or verifier feedback into a solving session, and never retries a consumed attempt.

## Workflow

1. Build the Sigma Linux runtime and obtain its SHA-256.
2. Package an explicit Codex Linux version from the official npm platform archive:

   ```powershell
   pnpm package:codex-runtime -- --version <version> --output <archive> --metadata-output <metadata.json>
   ```

3. Create a draft with two arms, a complete pinned task catalog, the shared model controls, repetitions, concurrency, and cumulative first-repetition ramp sizes.
4. Freeze it once:

   ```powershell
   pnpm bench:paired:preregister -- --draft <draft.json> --output <preregistration.json>
   ```

5. Run only the next unused stage. The first repetition is split by `ramp_task_counts`; later repetitions each form one stage.

   ```powershell
   pnpm bench:paired:run -- --preregistration-file <preregistration.json> --expected-preregistration-sha256 <sha256> --output <run-dir> --stage next
   ```

6. Analyze complete task×repetition pairs:

   ```powershell
   pnpm bench:paired:analyze -- --preregistration-file <preregistration.json> --expected-preregistration-sha256 <sha256> --experiment-output <run-dir> --output <analysis-dir>
   ```

## Stop-loss semantics

The controller stops on control drift, incomplete reports, infrastructure-invalid attempts, credential/provider unavailability, or dirty runtime/Docker cleanup. Ordinary verifier failures, agent timeouts, and efficiency regressions are recorded outcomes and do not stop rollout.

The irreversible boundary is immediately before Harbor dispatch. Once an attempt crosses it, its task×repetition×arm identity cannot be retried. A stopped stage therefore closes the experiment instead of using post-verifier information to repair or rerun attempts.

## Analysis

The report includes attempt pass rate with Wilson intervals, task-level pass-at-least-once, exact paired McNemar outcomes, order strata, cost/token/time summaries, joint-valid and joint-success paired ratios, and task-clustered bootstrap intervals. Sigma JSONL traces and Harbor ATIF Codex trajectories are normalized into model turns, tool calls, failures, repeated calls, validation events, tool histograms, and pairwise tool-sequence distance.
