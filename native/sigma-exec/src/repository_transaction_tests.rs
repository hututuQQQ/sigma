use super::*;
use std::process::Output;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);

fn test_root(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "sigma-repository-transaction-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ))
}

fn test_store(instance_id: &str) -> RepositoryTransactions {
    RepositoryTransactions::new_with_root(instance_id, test_root("journal-root"))
}

fn replacement_store(
    previous: &RepositoryTransactions,
    instance_id: &str,
) -> RepositoryTransactions {
    RepositoryTransactions::new_with_root(instance_id, previous.root.clone())
}

fn git(root: &Path, args: &[&str]) -> Output {
    Command::new("git")
        .current_dir(root)
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .output()
        .unwrap()
}

fn git_ok(root: &Path, args: &[&str]) -> String {
    let output = git(root, args);
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

fn repository(label: &str) -> PathBuf {
    let root = test_root(label);
    fs::create_dir_all(&root).unwrap();
    git_ok(&root, &["init", "-q", "--initial-branch=main"]);
    git_ok(&root, &["config", "user.email", "sigma@example.invalid"]);
    git_ok(&root, &["config", "user.name", "Sigma"]);
    fs::write(root.join("seed.txt"), b"seed\n").unwrap();
    git_ok(&root, &["add", "seed.txt"]);
    git_ok(&root, &["commit", "-qm", "seed"]);
    root
}

fn topology(root: &Path) -> (PathBuf, PathBuf) {
    let git_dir = PathBuf::from(git_ok(root, &["rev-parse", "--absolute-git-dir"]));
    let common_value = git_ok(root, &["rev-parse", "--git-common-dir"]);
    let common = Path::new(&common_value);
    let common = if common.is_absolute() {
        common.to_owned()
    } else {
        root.join(common).canonicalize().unwrap()
    };
    (
        git_dir.canonicalize().unwrap(),
        common.canonicalize().unwrap(),
    )
}

fn executable() -> Option<PathBuf> {
    trusted_git_executable("git").ok()
}

fn acquire_value(
    store: &RepositoryTransactions,
    root: &Path,
    session: &str,
    run: &str,
    maximum_bytes: Option<u64>,
) -> Option<Value> {
    let executable = executable()?;
    let (git_dir, common_dir) = topology(root);
    let value = store
        .acquire(AcquireRepositoryTransactionLeaseParams {
            protocol_version: 2,
            session_id: session.into(),
            run_id: run.into(),
            repository_root: root.to_owned(),
            git_dir,
            common_dir,
            executable: executable.to_string_lossy().into_owned(),
            network: NetworkMode::None,
            max_snapshot_files: None,
            max_snapshot_bytes: maximum_bytes,
        })
        .unwrap();
    Some(value)
}

fn acquire(
    store: &RepositoryTransactions,
    root: &Path,
    session: &str,
    run: &str,
    maximum_bytes: Option<u64>,
) -> Option<String> {
    let value = acquire_value(store, root, session, run, maximum_bytes)?;
    Some(value["leaseId"].as_str().unwrap().to_owned())
}

fn conflict_repository(label: &str) -> PathBuf {
    let root = repository(label);
    git_ok(&root, &["switch", "-qc", "topic"]);
    fs::write(root.join("seed.txt"), b"topic\n").unwrap();
    git_ok(&root, &["add", "seed.txt"]);
    git_ok(&root, &["commit", "-qm", "topic"]);
    git_ok(&root, &["switch", "-q", "main"]);
    fs::write(root.join("seed.txt"), b"main\n").unwrap();
    git_ok(&root, &["add", "seed.txt"]);
    git_ok(&root, &["commit", "-qm", "main"]);
    root
}

fn begin_conflict(store: &RepositoryTransactions, root: &Path, session: &str, run: &str) -> String {
    let lease_id = acquire(store, root, session, run, None).unwrap();
    let result = store
        .begin(
            1,
            BeginRepositoryTransactionParams {
                protocol_version: 2,
                lease_id,
                expected_postconditions: None,
                operations: vec![RepositoryOperationV2 {
                    operation_class: "merge".into(),
                    args: vec![
                        "merge".into(),
                        "--no-edit".into(),
                        "--no-verify".into(),
                        "--no-commit".into(),
                        "topic".into(),
                    ],
                }],
            },
        )
        .unwrap();
    assert_eq!(result["status"], "conflicts_pending");
    assert_eq!(result["conflictCount"], 1);
    result["transactionHandle"].as_str().unwrap().to_owned()
}

#[test]
fn conflict_begin_edit_continue_and_seal_is_broker_journaled() {
    let root = conflict_repository("continue");
    let store = test_store("test-continue");
    let Some(handle) = executable().map(|_| begin_conflict(&store, &root, "session-a", "run-a"))
    else {
        let _ = remove_any(&root);
        return;
    };
    fs::write(root.join("seed.txt"), b"main + topic\n").unwrap();
    let result = store
        .continue_transaction(
            2,
            ContinueRepositoryTransactionParams {
                protocol_version: 2,
                transaction_handle: handle.clone(),
                session_id: "session-a".into(),
                run_id: "run-a".into(),
                operations: vec![RepositoryOperationV2 {
                    operation_class: "add".into(),
                    args: vec!["add".into(), "--".into(), "seed.txt".into()],
                }],
            },
        )
        .unwrap();
    assert_eq!(result["status"], "completed_pending_seal");
    store
        .seal(BoundRepositoryTransactionParams {
            protocol_version: 2,
            transaction_handle: handle.clone(),
            session_id: "session-a".into(),
            run_id: "run-a".into(),
        })
        .unwrap();
    assert_eq!(
        git_ok(&root, &["rev-list", "--parents", "-n", "1", "HEAD"])
            .split_whitespace()
            .count(),
        3
    );
    assert_eq!(
        fs::read_to_string(root.join("seed.txt")).unwrap(),
        "main + topic\n"
    );
    let reused = store
        .seal(BoundRepositoryTransactionParams {
            protocol_version: 2,
            transaction_handle: handle,
            session_id: "session-a".into(),
            run_id: "run-a".into(),
        })
        .unwrap_err();
    assert_eq!(reused.code, "repository_transaction_handle_invalid");
    remove_any(&root).unwrap();
}

#[test]
fn abort_restores_exact_preimage_and_rejects_forged_or_cross_run_handles() {
    let root = conflict_repository("abort");
    let expected_head = git_ok(&root, &["rev-parse", "HEAD"]);
    let store = test_store("test-abort");
    let Some(handle) = executable().map(|_| begin_conflict(&store, &root, "session-b", "run-b"))
    else {
        let _ = remove_any(&root);
        return;
    };
    fs::write(root.join("seed.txt"), b"partial resolution\n").unwrap();
    let cross_run = store
        .abort(BoundRepositoryTransactionParams {
            protocol_version: 2,
            transaction_handle: handle.clone(),
            session_id: "session-b".into(),
            run_id: "other-run".into(),
        })
        .unwrap_err();
    assert_eq!(cross_run.code, "repository_transaction_handle_invalid");
    let forged = store
        .abort(BoundRepositoryTransactionParams {
            protocol_version: 2,
            transaction_handle: format!("{handle}0"),
            session_id: "session-b".into(),
            run_id: "run-b".into(),
        })
        .unwrap_err();
    assert_eq!(forged.code, "repository_transaction_handle_invalid");
    // Make Git's own abort path unusable. Broker preimage restoration must
    // remain authoritative and must not be skipped after this failure.
    fs::remove_file(root.join(".git").join("MERGE_HEAD")).unwrap();
    let result = store
        .abort(BoundRepositoryTransactionParams {
            protocol_version: 2,
            transaction_handle: handle,
            session_id: "session-b".into(),
            run_id: "run-b".into(),
        })
        .unwrap();
    assert_eq!(result["rollbackState"], "restored");
    assert_eq!(result["gitAbortSucceeded"], false);
    assert_eq!(git_ok(&root, &["rev-parse", "HEAD"]), expected_head);
    assert_eq!(fs::read_to_string(root.join("seed.txt")).unwrap(), "main\n");
    assert!(git_ok(&root, &["status", "--porcelain"]).is_empty());
    remove_any(&root).unwrap();
}

#[test]
fn cancellation_kills_the_active_git_child_and_restores_the_preimage() {
    let root = conflict_repository("cancel");
    let expected_head = git_ok(&root, &["rev-parse", "HEAD"]);
    let store = test_store("test-cancel");
    let Some(handle) = executable().map(|_| begin_conflict(&store, &root, "session-x", "run-x"))
    else {
        let _ = remove_any(&root);
        return;
    };
    fs::write(root.join("seed.txt"), b"partial resolution\n").unwrap();
    store.begin_request(900).unwrap();
    assert!(store.cancel_request(900));
    let error = store
        .continue_transaction(
            900,
            ContinueRepositoryTransactionParams {
                protocol_version: 2,
                transaction_handle: handle.clone(),
                session_id: "session-x".into(),
                run_id: "run-x".into(),
                operations: vec![RepositoryOperationV2 {
                    operation_class: "add".into(),
                    args: vec!["add".into(), "--".into(), "seed.txt".into()],
                }],
            },
        )
        .unwrap_err();
    store.finish_request(900);
    assert_eq!(error.code, "cancelled");
    assert!(!store.journal_path(&handle).exists());
    assert_eq!(git_ok(&root, &["rev-parse", "HEAD"]), expected_head);
    assert_eq!(fs::read_to_string(root.join("seed.txt")).unwrap(), "main\n");
    assert!(git_ok(&root, &["status", "--porcelain"]).is_empty());
    remove_any(&root).unwrap();
}

#[test]
fn graceful_shutdown_and_dead_owner_restart_recover_pending_transactions() {
    let root = conflict_repository("restart");
    let expected_head = git_ok(&root, &["rev-parse", "HEAD"]);
    let store = test_store("test-old-owner");
    let Some(handle) = executable().map(|_| begin_conflict(&store, &root, "session-c", "run-c"))
    else {
        let _ = remove_any(&root);
        return;
    };
    let mut journal = read_journal(&store.journal_path(&handle)).unwrap();
    journal.owner_pid = u32::MAX;
    write_journal(&store.journal_path(&handle), &journal).unwrap();
    let _replacement = replacement_store(&store, "test-new-owner");
    assert_eq!(git_ok(&root, &["rev-parse", "HEAD"]), expected_head);
    assert_eq!(fs::read_to_string(root.join("seed.txt")).unwrap(), "main\n");

    let second = begin_conflict(&store, &root, "session-d", "run-d");
    assert!(store.journal_path(&second).is_file());
    store.shutdown().expect("graceful transaction shutdown");
    assert!(!store.journal_path(&second).exists());
    assert_eq!(git_ok(&root, &["rev-parse", "HEAD"]), expected_head);
    remove_any(&root).unwrap();
}

#[test]
fn reused_live_pid_with_a_different_birth_identity_recovers_the_old_journal() {
    let root = conflict_repository("pid-reuse");
    let expected_head = git_ok(&root, &["rev-parse", "HEAD"]);
    let store = test_store("test-reused-pid-old-owner");
    let Some(handle) =
        executable().map(|_| begin_conflict(&store, &root, "session-pid", "run-pid"))
    else {
        let _ = remove_any(&root);
        return;
    };
    let mut journal = read_journal(&store.journal_path(&handle)).unwrap();
    journal.owner_pid = std::process::id();
    journal.owner_process_identity = Some("reused-process-birth-identity".into());
    write_journal(&store.journal_path(&handle), &journal).unwrap();

    let replacement = replacement_store(&store, "test-reused-pid-new-owner");
    assert!(
        replacement.initialization_error.is_none(),
        "PID-reuse recovery failed: {:?}",
        replacement.initialization_error
    );
    assert!(!store.journal_path(&handle).exists());
    assert_eq!(git_ok(&root, &["rev-parse", "HEAD"]), expected_head);
    assert_eq!(fs::read_to_string(root.join("seed.txt")).unwrap(), "main\n");
    remove_any(&root).unwrap();
}

#[test]
fn recovery_rejects_a_reused_repository_path_before_mutating_it() {
    let root = conflict_repository("identity-reuse");
    let displaced = test_root("identity-reuse-original");
    let store = test_store("test-identity-old-owner");
    let Some(handle) =
        executable().map(|_| begin_conflict(&store, &root, "session-identity", "run-identity"))
    else {
        let _ = remove_any(&root);
        return;
    };
    let mut journal = read_journal(&store.journal_path(&handle)).unwrap();
    journal.owner_process_identity = Some("dead-owner-before-path-reuse".into());
    write_journal(&store.journal_path(&handle), &journal).unwrap();
    fs::rename(&root, &displaced).unwrap();
    fs::create_dir_all(&root).unwrap();
    git_ok(&root, &["init", "-q", "--initial-branch=main"]);
    git_ok(&root, &["config", "user.email", "sigma@example.invalid"]);
    git_ok(&root, &["config", "user.name", "Sigma"]);
    fs::write(root.join("unrelated.txt"), b"must survive\n").unwrap();
    git_ok(&root, &["add", "unrelated.txt"]);
    git_ok(&root, &["commit", "-qm", "unrelated"]);
    let unrelated_head = git_ok(&root, &["rev-parse", "HEAD"]);

    let replacement = replacement_store(&store, "test-identity-new-owner");
    assert!(
        replacement
            .initialization_error
            .as_ref()
            .is_some_and(|(code, _)| { code == "repository_state_uncertain" })
    );
    assert_eq!(
        fs::read_to_string(root.join("unrelated.txt")).unwrap(),
        "must survive\n"
    );
    assert_eq!(git_ok(&root, &["rev-parse", "HEAD"]), unrelated_head);
    assert!(store.journal_path(&handle).exists());

    remove_any(&store.transaction_dir(&handle)).unwrap();
    remove_any(&root).unwrap();
    remove_any(&displaced).unwrap();
}

#[test]
fn runtime_owned_agent_state_fails_closed_before_git_writes() {
    let root = repository("agent-protected");
    let store = test_store("test-agent-protected");
    let Some(lease_id) = acquire(
        &store,
        &root,
        "session-agent-protected",
        "run-agent-protected",
        None,
    ) else {
        let _ = remove_any(&root);
        return;
    };
    fs::create_dir(root.join(".agent")).unwrap();
    fs::write(root.join(".agent/state"), b"runtime state").unwrap();
    let error = store
        .begin(
            72,
            BeginRepositoryTransactionParams {
                protocol_version: 2,
                lease_id,
                expected_postconditions: None,
                operations: vec![RepositoryOperationV2 {
                    operation_class: "branch".into(),
                    args: vec!["branch".into(), "must-not-exist".into()],
                }],
            },
        )
        .unwrap_err();
    assert_eq!(error.code, "repository_runtime_state_protected");
    assert_eq!(
        fs::read(root.join(".agent/state")).unwrap(),
        b"runtime state"
    );
    assert!(
        !git(
            &root,
            &["show-ref", "--verify", "refs/heads/must-not-exist"]
        )
        .status
        .success()
    );
    remove_any(&root).unwrap();
}

#[test]
fn tree_operation_cannot_publish_or_leave_runtime_owned_agent_state() {
    let root = repository("agent-introduced-by-tree");
    git_ok(&root, &["switch", "-qc", "contains-agent"]);
    fs::create_dir(root.join(".agent")).unwrap();
    fs::write(root.join(".agent/state"), b"tree payload").unwrap();
    git_ok(&root, &["add", ".agent/state"]);
    git_ok(&root, &["commit", "-qm", "contains protected state"]);
    git_ok(&root, &["switch", "-q", "main"]);
    assert!(!root.join(".agent").exists());

    let store = test_store("test-agent-tree-protected");
    let Some(lease_id) = acquire(&store, &root, "session-agent-tree", "run-agent-tree", None)
    else {
        let _ = remove_any(&root);
        return;
    };
    let error = store
        .begin(
            73,
            BeginRepositoryTransactionParams {
                protocol_version: 2,
                lease_id,
                expected_postconditions: None,
                operations: vec![RepositoryOperationV2 {
                    operation_class: "switch".into(),
                    args: vec!["switch".into(), "--detach".into(), "contains-agent".into()],
                }],
            },
        )
        .unwrap_err();
    assert_eq!(error.code, "repository_runtime_state_protected");
    assert!(!root.join(".agent").exists());
    assert_eq!(git_ok(&root, &["branch", "--show-current"]), "main");
    assert!(git_ok(&root, &["status", "--porcelain"]).is_empty());
    remove_any(&root).unwrap();
}

#[test]
fn seal_restores_the_preimage_when_final_runtime_state_checks_fail() {
    let root = repository("seal-agent-protected");
    let expected_head = git_ok(&root, &["rev-parse", "HEAD"]);
    let store = test_store("test-seal-agent-protected");
    let Some(lease_id) = acquire(&store, &root, "session-seal-agent", "run-seal-agent", None)
    else {
        let _ = remove_any(&root);
        return;
    };
    let result = store
        .begin(
            75,
            BeginRepositoryTransactionParams {
                protocol_version: 2,
                lease_id,
                expected_postconditions: None,
                operations: vec![RepositoryOperationV2 {
                    operation_class: "branch".into(),
                    args: vec!["branch".into(), "seal-must-rollback".into()],
                }],
            },
        )
        .unwrap();
    assert_eq!(result["status"], "completed_pending_seal");
    let handle = result["transactionHandle"].as_str().unwrap().to_owned();
    fs::create_dir(root.join(".agent")).unwrap();
    fs::write(root.join(".agent/state"), b"late runtime state").unwrap();

    let error = store
        .seal(BoundRepositoryTransactionParams {
            protocol_version: 2,
            transaction_handle: handle.clone(),
            session_id: "session-seal-agent".into(),
            run_id: "run-seal-agent".into(),
        })
        .unwrap_err();
    assert_eq!(error.code, "repository_runtime_state_protected");
    assert!(!root.join(".agent").exists());
    assert_eq!(git_ok(&root, &["rev-parse", "HEAD"]), expected_head);
    assert!(git_ok(&root, &["status", "--porcelain"]).is_empty());
    assert!(
        !git(
            &root,
            &["show-ref", "--verify", "refs/heads/seal-must-rollback"]
        )
        .status
        .success()
    );
    assert!(!store.journal_path(&handle).exists());
    remove_any(&root).unwrap();
}

#[test]
fn repository_signing_helpers_are_rejected_before_git_writes() {
    for (index, (key, value)) in [
        ("merge.gpgSign", "true"),
        ("merge.verifySignatures", "true"),
        ("rebase.gpgSign", "true"),
        ("gpg.program", "untrusted-signing-helper"),
        ("gpg.ssh.program", "untrusted-ssh-signing-helper"),
    ]
    .into_iter()
    .enumerate()
    {
        let root = repository(&format!("signing-helper-protected-{index}"));
        git_ok(&root, &["config", key, value]);
        let store = test_store(&format!("test-signing-helper-protected-{index}"));
        let Some(lease_id) = acquire(
            &store,
            &root,
            "session-signing-helper",
            "run-signing-helper",
            None,
        ) else {
            let _ = remove_any(&root);
            return;
        };
        let error = store
            .begin(
                74 + index as u64,
                BeginRepositoryTransactionParams {
                    protocol_version: 2,
                    lease_id,
                    expected_postconditions: None,
                    operations: vec![RepositoryOperationV2 {
                        operation_class: "branch".into(),
                        args: vec!["branch".into(), "must-not-exist".into()],
                    }],
                },
            )
            .unwrap_err();
        assert_eq!(error.code, "repository_external_helper_denied", "{key}");
        assert!(
            !git(
                &root,
                &["show-ref", "--verify", "refs/heads/must-not-exist"]
            )
            .status
            .success()
        );
        remove_any(&root).unwrap();
    }
}

#[test]
fn native_git_grammar_rejects_shell_signing_strategy_and_magic_pathspecs() {
    for operation in [
        RepositoryOperationV2 {
            operation_class: "rebase".into(),
            args: vec![
                "rebase".into(),
                "-x".into(),
                "echo escaped".into(),
                "HEAD~1".into(),
            ],
        },
        RepositoryOperationV2 {
            operation_class: "commit".into(),
            args: vec!["commit".into(), "-S".into(), "-m".into(), "signed".into()],
        },
        RepositoryOperationV2 {
            operation_class: "merge".into(),
            args: vec![
                "merge".into(),
                "-s".into(),
                "external".into(),
                "topic".into(),
            ],
        },
        RepositoryOperationV2 {
            operation_class: "add".into(),
            args: vec!["add".into(), "--".into(), ":(glob).agent/**".into()],
        },
    ] {
        assert_eq!(
            validate_operations(&[operation], false).unwrap_err().code,
            "repository_transaction_invalid"
        );
    }
}

#[test]
fn native_git_grammar_accepts_only_the_structured_builder_shapes() {
    let operations = [
        ("add", vec!["add", "--", "src/file.txt"]),
        (
            "restore",
            vec![
                "restore",
                "--source=HEAD",
                "--staged",
                "--worktree",
                "--",
                "src/file.txt",
            ],
        ),
        ("switch", vec!["switch", "-c", "topic", "HEAD"]),
        ("switch", vec!["switch", "--detach", "HEAD"]),
        (
            "commit",
            vec!["commit", "--amend", "--no-verify", "-m", "message"],
        ),
        ("branch", vec!["branch", "-f", "topic", "HEAD"]),
        ("branch", vec!["branch", "-M", "topic", "renamed"]),
        ("tag", vec!["tag", "-f", "v1", "HEAD"]),
        ("reset", vec!["reset", "--hard", "HEAD"]),
        (
            "merge",
            vec!["merge", "--no-edit", "--no-verify", "--no-commit", "topic"],
        ),
        ("rebase", vec!["rebase", "--onto", "main", "base", "topic"]),
        ("cherry_pick", vec!["cherry-pick", "HEAD~1", "HEAD"]),
        ("revert", vec!["revert", "--no-edit", "HEAD"]),
        (
            "update_ref",
            vec!["update-ref", "refs/heads/topic", "HEAD", "HEAD~1"],
        ),
        (
            "reflog_expire",
            vec!["reflog", "expire", "--expire=now", "--all"],
        ),
        ("gc", vec!["gc", "--prune=now", "--aggressive"]),
    ];
    for (class, args) in operations {
        validate_operations(
            &[RepositoryOperationV2 {
                operation_class: class.into(),
                args: args.into_iter().map(str::to_owned).collect(),
            }],
            false,
        )
        .unwrap_or_else(|error| panic!("{class} builder shape was rejected: {}", error.message));
    }
}

#[test]
fn linked_worktree_binds_and_mutates_its_common_directory() {
    let primary = repository("linked-primary");
    let linked = test_root("linked-worktree");
    let linked_text = linked.to_string_lossy().into_owned();
    git_ok(
        &primary,
        &["worktree", "add", "-q", "-b", "linked-base", &linked_text],
    );
    let store = test_store("test-linked");
    let Some(lease_id) = acquire(&store, &linked, "session-e", "run-e", None) else {
        let _ = remove_any(&primary);
        let _ = remove_any(&linked);
        return;
    };
    let result = store
        .begin(
            3,
            BeginRepositoryTransactionParams {
                protocol_version: 2,
                lease_id,
                expected_postconditions: None,
                operations: vec![RepositoryOperationV2 {
                    operation_class: "branch".into(),
                    args: vec!["branch".into(), "linked-created".into()],
                }],
            },
        )
        .unwrap();
    assert_eq!(result["status"], "completed_pending_seal");
    let handle = result["transactionHandle"].as_str().unwrap().to_owned();
    store
        .seal(BoundRepositoryTransactionParams {
            protocol_version: 2,
            transaction_handle: handle,
            session_id: "session-e".into(),
            run_id: "run-e".into(),
        })
        .unwrap();
    assert!(
        git_ok(
            &primary,
            &["show-ref", "--verify", "refs/heads/linked-created"]
        )
        .contains("refs/heads/linked-created")
    );
    git_ok(&primary, &["worktree", "remove", "--force", &linked_text]);
    remove_any(&primary).unwrap();
}

#[test]
fn corrupted_content_addressed_preimage_fails_closed_without_consuming_the_journal() {
    let root = conflict_repository("corrupt-cas");
    let store = test_store("test-corrupt-cas");
    let Some(handle) =
        executable().map(|_| begin_conflict(&store, &root, "session-cas", "run-cas"))
    else {
        let _ = remove_any(&root);
        return;
    };
    let journal = read_journal(&store.journal_path(&handle)).unwrap();
    let snapshot = store
        .transaction_dir(&handle)
        .join("cas")
        .join(&journal.preimage_digest);
    assert_eq!(tree_digest(&snapshot).unwrap(), journal.preimage_digest);
    fs::write(snapshot.join("worktree").join("seed.txt"), b"tampered\n").unwrap();

    let error = store
        .abort(BoundRepositoryTransactionParams {
            protocol_version: 2,
            transaction_handle: handle.clone(),
            session_id: "session-cas".into(),
            run_id: "run-cas".into(),
        })
        .unwrap_err();
    assert_eq!(error.code, "repository_state_uncertain");
    let persisted = read_journal(&store.journal_path(&handle)).unwrap();
    assert_eq!(persisted.status, JournalStatus::RepositoryStateUncertain);
    assert!(store.transaction_dir(&handle).is_dir());
    let shutdown_error = store
        .shutdown()
        .expect_err("shutdown must report rollback uncertainty");
    assert_eq!(shutdown_error.code, "repository_state_uncertain");
    assert!(store.journal_path(&handle).is_file());

    remove_any(&store.transaction_dir(&handle)).unwrap();
    remove_any(&root).unwrap();
}

#[test]
fn snapshot_limit_fails_during_lease_acquisition_before_the_first_repository_write() {
    let root = repository("limit");
    let store = test_store("test-limit");
    let Some(executable) = executable() else {
        let _ = remove_any(&root);
        return;
    };
    let (git_dir, common_dir) = topology(&root);
    let error = store
        .acquire(AcquireRepositoryTransactionLeaseParams {
            protocol_version: 2,
            session_id: "session-f".into(),
            run_id: "run-f".into(),
            repository_root: root.clone(),
            git_dir,
            common_dir,
            executable: executable.to_string_lossy().into_owned(),
            network: NetworkMode::None,
            max_snapshot_files: None,
            max_snapshot_bytes: Some(1),
        })
        .unwrap_err();
    assert_eq!(error.code, "repository_checkpoint_too_large");
    assert!(
        !git(
            &root,
            &["show-ref", "--verify", "refs/heads/must-not-exist"]
        )
        .status
        .success()
    );
    remove_any(&root).unwrap();
}

#[test]
fn forged_and_reused_write_leases_are_rejected_before_additional_writes() {
    let root = repository("lease-reuse");
    let store = test_store("test-lease-reuse");
    let Some(lease_id) = acquire(&store, &root, "session-g", "run-g", None) else {
        let _ = remove_any(&root);
        return;
    };
    let forged = store
        .begin(
            50,
            BeginRepositoryTransactionParams {
                protocol_version: 2,
                lease_id: format!("{lease_id}0"),
                expected_postconditions: None,
                operations: vec![RepositoryOperationV2 {
                    operation_class: "branch".into(),
                    args: vec!["branch".into(), "forged-must-not-exist".into()],
                }],
            },
        )
        .unwrap_err();
    assert_eq!(forged.code, "repository_transaction_handle_invalid");
    let result = store
        .begin(
            51,
            BeginRepositoryTransactionParams {
                protocol_version: 2,
                lease_id: lease_id.clone(),
                expected_postconditions: None,
                operations: vec![RepositoryOperationV2 {
                    operation_class: "branch".into(),
                    args: vec!["branch".into(), "lease-created".into()],
                }],
            },
        )
        .unwrap();
    let handle = result["transactionHandle"].as_str().unwrap().to_owned();
    store
        .seal(BoundRepositoryTransactionParams {
            protocol_version: 2,
            transaction_handle: handle,
            session_id: "session-g".into(),
            run_id: "run-g".into(),
        })
        .unwrap();
    let reused = store
        .begin(
            52,
            BeginRepositoryTransactionParams {
                protocol_version: 2,
                lease_id,
                expected_postconditions: None,
                operations: vec![RepositoryOperationV2 {
                    operation_class: "branch".into(),
                    args: vec!["branch".into(), "reused-must-not-exist".into()],
                }],
            },
        )
        .unwrap_err();
    assert_eq!(reused.code, "repository_transaction_handle_invalid");
    assert!(
        git_ok(&root, &["show-ref", "--verify", "refs/heads/lease-created"])
            .contains("refs/heads/lease-created")
    );
    assert!(
        !git(
            &root,
            &["show-ref", "--verify", "refs/heads/reused-must-not-exist"]
        )
        .status
        .success()
    );
    remove_any(&root).unwrap();
}

#[test]
fn v3_selected_head_postconditions_are_returned_and_sealed() {
    let root = repository("v3-selected-head");
    fs::write(root.join("seed.txt"), b"second\n").unwrap();
    git_ok(&root, &["add", "seed.txt"]);
    git_ok(&root, &["commit", "-qm", "second"]);
    let target = git_ok(&root, &["rev-parse", "HEAD~1"]);
    let store = test_store("test-v3-selected-head");
    let Some(lease_id) = acquire(&store, &root, "session-v3", "run-v3", None) else {
        let _ = remove_any(&root);
        return;
    };
    let result = store
        .begin(
            80,
            BeginRepositoryTransactionParams {
                protocol_version: 3,
                lease_id,
                expected_postconditions: Some(RepositoryExpectedPostconditionsV3 {
                    schema_version: 3,
                    selected_head: target.clone(),
                    selected_symbolic_ref: Some("refs/heads/main".into()),
                    required_reachable_objects: vec![target.clone()],
                }),
                operations: vec![RepositoryOperationV2 {
                    operation_class: "reset".into(),
                    args: vec!["reset".into(), "--hard".into(), target.clone()],
                }],
            },
        )
        .unwrap();
    assert_eq!(result["protocolVersion"], 3);
    assert_eq!(
        result["semanticAssertions"]["targetAssertions"]["selectedHead"],
        target
    );
    assert_eq!(git_ok(&root, &["rev-parse", "HEAD"]), target);
    let handle = result["transactionHandle"].as_str().unwrap().to_owned();
    store
        .seal(BoundRepositoryTransactionParams {
            protocol_version: 2,
            transaction_handle: handle,
            session_id: "session-v3".into(),
            run_id: "run-v3".into(),
        })
        .unwrap();
    remove_any(&root).unwrap();
}

#[test]
fn wrong_v3_selected_head_assertion_aborts_and_restores_preimage() {
    let root = repository("v3-wrong-head");
    fs::write(root.join("seed.txt"), b"second\n").unwrap();
    git_ok(&root, &["add", "seed.txt"]);
    git_ok(&root, &["commit", "-qm", "second"]);
    let before = git_ok(&root, &["rev-parse", "HEAD"]);
    let target = git_ok(&root, &["rev-parse", "HEAD~1"]);
    let store = test_store("test-v3-wrong-head");
    let Some(lease_id) = acquire(&store, &root, "session-v3b", "run-v3b", None) else {
        let _ = remove_any(&root);
        return;
    };
    let error = store
        .begin(
            81,
            BeginRepositoryTransactionParams {
                protocol_version: 3,
                lease_id,
                expected_postconditions: Some(RepositoryExpectedPostconditionsV3 {
                    schema_version: 3,
                    selected_head: before.clone(),
                    selected_symbolic_ref: Some("refs/heads/main".into()),
                    required_reachable_objects: vec![before.clone()],
                }),
                operations: vec![RepositoryOperationV2 {
                    operation_class: "reset".into(),
                    args: vec!["reset".into(), "--hard".into(), target],
                }],
            },
        )
        .unwrap_err();
    assert_eq!(error.code, "repository_postcondition_failed");
    assert_eq!(git_ok(&root, &["rev-parse", "HEAD"]), before);
    assert_eq!(fs::read(root.join("seed.txt")).unwrap(), b"second\n");
    remove_any(&root).unwrap();
}

fn run_baseline_params(value: &Value, root: &Path) -> RestoreRepositoryRunBaselineParams {
    RestoreRepositoryRunBaselineParams {
        protocol_version: 1,
        baseline_id: value["runBaseline"]["baselineId"]
            .as_str()
            .unwrap()
            .to_owned(),
        restore_capability: value["runBaseline"]["restoreCapability"]
            .as_str()
            .unwrap()
            .to_owned(),
        session_id: value["sessionId"].as_str().unwrap().to_owned(),
        run_id: value["runId"].as_str().unwrap().to_owned(),
        repository_root: root.to_owned(),
    }
}

#[test]
fn sealed_transactions_share_one_run_baseline_and_restore_exact_repository_state() {
    let root = repository("run-baseline-multiple");
    let initial_head = git_ok(&root, &["rev-parse", "HEAD"]);
    let store = test_store("test-run-baseline-multiple");
    let Some(first_lease) = acquire_value(&store, &root, "session-baseline", "run-baseline", None)
    else {
        let _ = remove_any(&root);
        return;
    };
    let first = store
        .begin(
            90,
            BeginRepositoryTransactionParams {
                protocol_version: 2,
                lease_id: first_lease["leaseId"].as_str().unwrap().to_owned(),
                expected_postconditions: None,
                operations: vec![RepositoryOperationV2 {
                    operation_class: "branch".into(),
                    args: vec!["branch".into(), "created-in-run".into()],
                }],
            },
        )
        .unwrap();
    store
        .seal(BoundRepositoryTransactionParams {
            protocol_version: 2,
            transaction_handle: first["transactionHandle"].as_str().unwrap().to_owned(),
            session_id: "session-baseline".into(),
            run_id: "run-baseline".into(),
        })
        .unwrap();

    fs::write(root.join("seed.txt"), b"changed in run\n").unwrap();
    let second_lease =
        acquire_value(&store, &root, "session-baseline", "run-baseline", None).unwrap();
    assert_eq!(
        first_lease["runBaseline"]["baselineId"],
        second_lease["runBaseline"]["baselineId"]
    );
    let second = store
        .begin(
            91,
            BeginRepositoryTransactionParams {
                protocol_version: 2,
                lease_id: second_lease["leaseId"].as_str().unwrap().to_owned(),
                expected_postconditions: None,
                operations: vec![
                    RepositoryOperationV2 {
                        operation_class: "add".into(),
                        args: vec!["add".into(), "--".into(), "seed.txt".into()],
                    },
                    RepositoryOperationV2 {
                        operation_class: "commit".into(),
                        args: vec![
                            "commit".into(),
                            "--no-verify".into(),
                            "-m".into(),
                            "changed".into(),
                        ],
                    },
                ],
            },
        )
        .unwrap();
    store
        .seal(BoundRepositoryTransactionParams {
            protocol_version: 2,
            transaction_handle: second["transactionHandle"].as_str().unwrap().to_owned(),
            session_id: "session-baseline".into(),
            run_id: "run-baseline".into(),
        })
        .unwrap();

    let params = run_baseline_params(&first_lease, &root);
    let baseline_id = params.baseline_id.clone();
    let result = store.restore_run_baseline(params).unwrap();
    assert_eq!(result["status"], "restored");
    assert_eq!(result["semanticAssertions"]["head"], initial_head);
    assert_eq!(git_ok(&root, &["rev-parse", "HEAD"]), initial_head);
    assert_eq!(fs::read(root.join("seed.txt")).unwrap(), b"seed\n");
    assert!(git_ok(&root, &["status", "--porcelain"]).is_empty());
    assert!(
        !git(
            &root,
            &["show-ref", "--verify", "refs/heads/created-in-run"]
        )
        .status
        .success()
    );
    assert!(!store.run_baseline_dir(&baseline_id).exists());

    let replay = store
        .restore_run_baseline(run_baseline_params(&first_lease, &root))
        .unwrap_err();
    assert_eq!(replay.code, "repository_transaction_handle_invalid");
    remove_any(&root).unwrap();
}

#[test]
fn run_baseline_capability_rejects_cross_session_run_and_repository_bindings() {
    let root = repository("run-baseline-binding");
    let other = repository("run-baseline-binding-other");
    let store = test_store("test-run-baseline-binding");
    let Some(lease) = acquire_value(&store, &root, "session-a", "run-a", None) else {
        let _ = remove_any(&root);
        let _ = remove_any(&other);
        return;
    };
    for mutation in ["session", "run", "repository", "capability"] {
        let mut params = run_baseline_params(&lease, &root);
        match mutation {
            "session" => params.session_id = "session-b".into(),
            "run" => params.run_id = "run-b".into(),
            "repository" => params.repository_root = other.clone(),
            "capability" => params.restore_capability = random_capability("rrc1").unwrap(),
            _ => unreachable!(),
        }
        let error = store.restore_run_baseline(params).unwrap_err();
        assert_eq!(
            error.code, "repository_transaction_handle_invalid",
            "{mutation}"
        );
    }
    store
        .restore_run_baseline(run_baseline_params(&lease, &root))
        .unwrap();
    remove_any(&root).unwrap();
    remove_any(&other).unwrap();
}

#[test]
fn run_baseline_release_consumes_capability_and_cleans_snapshot() {
    let root = repository("run-baseline-release");
    let store = test_store("test-run-baseline-release");
    let Some(lease) = acquire_value(&store, &root, "session-release", "run-release", None) else {
        let _ = remove_any(&root);
        return;
    };
    let restore = run_baseline_params(&lease, &root);
    let baseline_id = restore.baseline_id.clone();
    let result = store
        .release_run_baseline(ReleaseRepositoryRunBaselineParams {
            protocol_version: restore.protocol_version,
            baseline_id: restore.baseline_id,
            restore_capability: restore.restore_capability,
            session_id: restore.session_id,
            run_id: restore.run_id,
            repository_root: restore.repository_root,
        })
        .unwrap();
    assert_eq!(result["status"], "released");
    assert!(!store.run_baseline_dir(&baseline_id).exists());
    let replay = store
        .release_run_baseline(ReleaseRepositoryRunBaselineParams {
            protocol_version: 1,
            baseline_id: baseline_id.clone(),
            restore_capability: lease["runBaseline"]["restoreCapability"]
                .as_str()
                .unwrap()
                .to_owned(),
            session_id: "session-release".into(),
            run_id: "run-release".into(),
            repository_root: root.clone(),
        })
        .unwrap_err();
    assert_eq!(replay.code, "repository_transaction_handle_invalid");
    remove_any(&root).unwrap();
}

#[test]
fn corrupted_run_baseline_is_consumed_and_reports_repository_state_uncertain() {
    let root = repository("run-baseline-corrupt");
    let store = test_store("test-run-baseline-corrupt");
    let Some(lease) = acquire_value(&store, &root, "session-corrupt", "run-corrupt", None) else {
        let _ = remove_any(&root);
        return;
    };
    let params = run_baseline_params(&lease, &root);
    let baseline = read_run_baseline(&store.run_baseline_path(&params.baseline_id)).unwrap();
    fs::write(
        store
            .run_baseline_dir(&params.baseline_id)
            .join("cas")
            .join(&baseline.preimage_digest)
            .join("worktree")
            .join("seed.txt"),
        b"tampered snapshot\n",
    )
    .unwrap();
    fs::write(root.join("seed.txt"), b"changed current state\n").unwrap();
    let error = store.restore_run_baseline(params).unwrap_err();
    assert_eq!(error.code, "repository_state_uncertain");
    let persisted = read_run_baseline(
        &store.run_baseline_path(lease["runBaseline"]["baselineId"].as_str().unwrap()),
    )
    .unwrap();
    assert_eq!(
        persisted.status,
        RunBaselineStatus::RepositoryStateUncertain
    );
    let replay = store
        .restore_run_baseline(run_baseline_params(&lease, &root))
        .unwrap_err();
    assert_eq!(replay.code, "repository_transaction_handle_invalid");
    remove_any(&store.run_baseline_dir(&persisted.baseline_id)).unwrap();
    remove_any(&root).unwrap();
}

#[test]
fn dead_broker_run_baseline_rebinds_only_through_a_fresh_matching_lease() {
    let root = repository("run-baseline-rebind");
    let store = test_store("test-run-baseline-rebind-old");
    let Some(first_lease) = acquire_value(&store, &root, "session-rebind", "run-rebind", None)
    else {
        let _ = remove_any(&root);
        return;
    };
    let transaction = store
        .begin(
            92,
            BeginRepositoryTransactionParams {
                protocol_version: 2,
                lease_id: first_lease["leaseId"].as_str().unwrap().to_owned(),
                expected_postconditions: None,
                operations: vec![RepositoryOperationV2 {
                    operation_class: "branch".into(),
                    args: vec!["branch".into(), "rebind-created".into()],
                }],
            },
        )
        .unwrap();
    store
        .seal(BoundRepositoryTransactionParams {
            protocol_version: 2,
            transaction_handle: transaction["transactionHandle"]
                .as_str()
                .unwrap()
                .to_owned(),
            session_id: "session-rebind".into(),
            run_id: "run-rebind".into(),
        })
        .unwrap();
    let first_binding = run_baseline_params(&first_lease, &root);
    let mut manifest =
        read_run_baseline(&store.run_baseline_path(&first_binding.baseline_id)).unwrap();
    manifest.owner_pid = u32::MAX;
    manifest.owner_process_identity = None;
    store.persist_run_baseline(&manifest).unwrap();
    store.run_baselines.lock().unwrap().clear();

    let replacement = replacement_store(&store, "test-run-baseline-rebind-new");
    let rebound = acquire_value(&replacement, &root, "session-rebind", "run-rebind", None).unwrap();
    assert_eq!(
        rebound["runBaseline"]["baselineId"],
        first_lease["runBaseline"]["baselineId"]
    );
    assert_eq!(
        rebound["runBaseline"]["restoreCapability"],
        first_lease["runBaseline"]["restoreCapability"]
    );
    replacement
        .restore_run_baseline(run_baseline_params(&rebound, &root))
        .unwrap();
    assert!(
        !git(
            &root,
            &["show-ref", "--verify", "refs/heads/rebind-created"]
        )
        .status
        .success()
    );
    remove_any(&root).unwrap();
}
