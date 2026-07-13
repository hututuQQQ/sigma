# Sigma agent experience fixtures

`manifest.json` is the versioned, data-driven catalogue consumed by the
evaluation runner. Each scenario's `workspace/` directory is copied into a new
randomly named Git repository. `fixture.setupAfterCommit` is then applied to
model pre-existing user changes without scenario-specific runner logic.

Only `userMessages` and scheduled interaction action text are sent to Sigma.
Scenario ids, budgets, expected terminal states, allowed paths, verifier checks,
and the files outside `workspace/` are evaluator-only data. Verifier commands
run only after the Sigma process has terminated. `$WORKSPACE` and
`$MANIFEST_DIR` in command arguments are expanded by the runner.

The shared verifier is intentionally generic. Scenario-specific expectations
live in evaluator-only `verifier.json` files rather than in the subject prompt
or production code.
