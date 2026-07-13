# Optimizer boundary contract

## Allowed optimizer input

Use only the strict fields carried by `OptimizerObservationV1`:

- opaque observation, source, product, configuration, environment, and cluster digests;
- platform, surface, provider, and model identifiers;
- terminal category and stable terminal code;
- normalized subsystem, failure family, diagnostic codes, tool family, effect class, and semantic-progress state;
- aggregate duration, turns, calls, failures, tokens, cost, same-root attempts, overshoot, and mutation count;
- redacted event sequence references;
- blocker status.

Cluster eligibility requires either one blocker or the same cluster in three independent sources within seven days. Only one experiment may be active per cluster.

## Forbidden optimizer input

Reject unknown fields and any field or content carrying:

- benchmark, suite, scenario, task, dataset, or fixture identity;
- verifier identity, commands, failures, traces, standard output, or standard error;
- rewards, scores, expected output, or known answers;
- original prompts, tool arguments, command text, raw events, or absolute paths;
- scenario-specific paths, permissions, budgets, schedules, or retry hints.

Do not open nearby files to reconstruct forbidden information. The local `EvaluationVault` is human-audit evidence, not optimizer context.

## Allowed candidate work

Modify general product code under `packages/` or `native/` and ordinary non-evaluation tests under `tests/`. Add a generic reproduction or property test. The experiment may name only these general modification globs.

## Forbidden candidate work

Do not modify `scripts/eval/`, `test-fixtures/`, formal reports, workflow schedules, benchmark adapters, optimizer schemas, or this skill. Do not add task-specific skills, path allowlists, prompt phrases, known-output assertions, adaptive retries, or post-verifier repair behavior.

## External gate

The external gate runs exactly three frozen baseline/candidate pairs in the preregistered order. An invalid pair rejects the frozen candidate without retry. Binary metrics require at least two candidate wins and zero losses. Continuous metrics require every pair to be non-inferior and the paired median change to meet the preregistered threshold. Any correctness, safety, or delivery regression rejects the candidate.

The gate returns a decision to the human reviewer. It never sends evidence or failure details back into the Codex task.
