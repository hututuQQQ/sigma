---
name: sigma-eval-improver
description: Turn an eligible, sanitized Sigma OptimizerObservationV1 cluster card into one general product-invariant fix, preregister its OptimizationExperimentV1, and prepare a draft PR. Use for Sigma reliability, convergence, sandbox, completion, or workspace-discipline clusters produced by the local optimizer observation pipeline. Do not use for formal evaluation result analysis, task-specific tuning, or follow-up patches based on verifier feedback.
---

# Sigma Eval Improver

Implement exactly one reusable Sigma product invariant from sanitized evidence. Keep the optimizer and formal evaluation as two one-way systems.

## Enforce the input boundary

1. Accept only an `OptimizerObservationV1` or `sigma.optimizer-cluster-card` produced by `pnpm eval:observe`.
2. Validate every observation with `assertOptimizerObservationV1` before reasoning from it.
3. Read the cluster card and product source only.
4. Never read `EvaluationVault`, raw session events, formal evaluation artifacts, fixture workspaces, verifier logs, rewards, scores, expected results, or original user prompts.
5. Stop if the card is ineligible or reports an active experiment.

Read [boundary-contract.md](references/boundary-contract.md) before modifying code.

## Preregister one experiment

State one general invariant without task wording, repository-path exceptions, known outputs, or benchmark identities. Describe one causal hypothesis and one primary metric.

Create an `OptimizationExperimentV1` in the external Sigma state area, never in the candidate worktree, with:

- exactly one cluster;
- one primary binary or continuous metric;
- correctness, safety, and delivery non-regression guardrails;
- product-code and ordinary test globs only;
- a concrete rollback trigger and steps;
- all fairness declarations set to true;
- the frozen three-pair interleaved policy.

Run `pnpm eval:experiment -- validate <experiment-file>`, then `pnpm eval:experiment -- register <experiment-file>` before implementation. Registration enforces one active experiment per cluster. Do not modify evaluator scripts, evaluation fixtures, reports, schedules, or this skill from an optimization candidate.

## Implement the invariant

1. Create or switch to `codex/sigma-improve-<cluster-hash>` in the isolated worktree.
2. Inspect only the owning product subsystem and broadly applicable project conventions.
3. Implement the smallest general fix. Never branch on benchmark names, task identities, prompts, paths, package names, verifier information, or known outputs.
4. Add at least one ordinary unit test, property test, or generic reproduction that would remain useful without the evaluation system.
5. Run only the focused general product tests and `pnpm build`.
6. Run the fairness scan even when other validation fails.

`pnpm eval:conformance`, live canaries, and formal A/B belong to the external
trusted gate. Do not run them in this Codex task and do not read their output;
they contain evaluator-facing identities and feedback that are outside this
skill's input boundary.

## Freeze and hand off

After the candidate and general tests pass:

1. Commit the candidate once and run `pnpm eval:product-digest`; use its SHA-256 product digest.
2. Freeze the existing experiment with `pnpm eval:experiment -- freeze <experiment-file> <candidate-digest>`.
3. Do not commit the experiment or any evaluator metadata. Put only its opaque experiment ID in the draft PR body.
4. Push the branch and open one draft PR. Never enable auto-merge.
5. Summarize the invariant, product tests, primary metric, guardrails, and rollback plan without evaluation identities.
6. End the task. Do not inspect formal A/B evidence, resume this task after rejection, or create a second candidate from post-verifier information.

Formal A/B is an external acceptance gate. A rejection closes the experiment; a new candidate requires new real-session or generic-conformance evidence and a fresh experiment.
