# Sigma Evaluation V2

Sigma Evaluation V2 separates product behavior, evaluator validity, human-only evidence, and optimizer-safe observations. It deliberately does not produce a composite score.

## Validation tiers

- Pull requests run `pnpm eval:conformance`. This is deterministic and does not call a live model.
- Nightly runs the frozen quick suite once and exports only a canary status. It cannot claim improvement or regression.
- Weekly runs the experience and repository-scale suites three times. Missing, invalid, mixed-platform, incomplete-metric, or legacy samples are reported as inconclusive.
- Formal candidate evaluation uses three frozen interleaved baseline/candidate pairs. It accepts or rejects a single preregistered candidate and never retries from verifier feedback.

The normal validation sequence is:

```text
pnpm eval:conformance
pnpm lint
pnpm build
```

Live evaluation additionally requires the pinned provider secret and the platform sandbox dependency.

## Data boundaries

`EvalAttemptV2` separates validity from correctness, delivery, safety, experience, and reliability. Evaluator or verifier failures are invalid samples; Sigma-owned sandbox, provider, and tool failures remain valid reliability failures.

Raw traces are compressed into the owner-only `EvaluationVault`, with content-addressed SHA-256 manifests and a hard 5 GB stop. The vault is never uploaded automatically and is deleted only by an explicit archive ID confirmation.

`OptimizerObservationV1` is a strict allowlist projection. It excludes prompts, commands, paths, task or scenario identity, verifier data, expected outputs, scores, and raw events. Only provenance-attested observations can make a cluster eligible. One blocker or three independent observations in seven days may open one active experiment.

## Trusted deployment requirements

Repository code supplies fail-closed protocols for the formal scheduler and generic-conformance trust verifier; these are not security boundaries by themselves. A production deployment must provide:

- a launcher/runtime subject attestation bound to the exact product, build, configuration, and environment;
- an OS containment boundary for the complete subject process tree;
- a trusted build scheduler that supplies artifact, SBOM, dependency, environment, toolchain, and verifier-runtime attestations;
- a separate principal or equivalent capability boundary if optimizer Codex must be technically unable to read `EvaluationVault`;
- an external signature or injected trust verifier before generic conformance evidence can become optimizer-eligible.

Without those authorities, collection remains useful for human audit but candidate eligibility and formal A/B fail closed.

## Optimizer workflow

Use the repository skill at `.agents/skills/sigma-eval-improver`. It accepts only an eligible sanitized cluster card and product source, preregisters one general invariant, changes product code plus ordinary tests, freezes one candidate, and opens a draft PR. Formal results never return to that Codex task.

