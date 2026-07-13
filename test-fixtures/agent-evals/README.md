# Sigma agent experience fixtures

`manifest.json` is the versioned, data-driven catalogue consumed by the
evaluation runner. Each scenario's `workspace/` directory is copied into a new
randomly named Git repository. `fixture.setupAfterCommit` is then applied to
model pre-existing user changes and evaluator-only link topology without
scenario-specific runner logic. The `repo-scale-v1` generator deterministically
creates the shared 500-file, 90,000-line multilingual family at run time.

Only the mandatory `SubjectDriverSpecV2` projection (messages, surface,
permissions, and interactions) carries scenario data to the subject driver.
Scenario ids, frozen suite policies, expected terminal states, allowed paths,
fixtures, verifier checks, and the files outside `workspace/` are evaluator-only
data. Verifier commands run only after the Sigma process has terminated and
operate on an isolated evidence copy. `$WORKSPACE` and
`$MANIFEST_DIR` in command arguments are expanded by the runner.

The shared verifier is intentionally generic. Scenario-specific expectations
live in evaluator-only `verifier.json` files rather than in the subject prompt
or production code.
