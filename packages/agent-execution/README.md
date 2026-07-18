# agent-execution

This package is the only Sigma Code production boundary that starts arbitrary
processes. `SigmaExecBrokerClient` talks to the bundled `sigma-exec` helper;
callers never invoke a shell implicitly.

```ts
const broker = new SigmaExecBrokerClient({ helperPath });
await broker.connect(); // fails if the required sandbox self-test is not healthy

const result = await broker.execute({
  command: { executable: "npm", args: ["test"], cwd: workspace },
  policy: {
    sandbox: "required",
    network: "none",
    readRoots: [workspace],
    writeRoots: [`${workspace}/src`]
  }
});
```

Security invariants:

- Required sandbox execution never falls back to a host process.
- `network: "full"` requires `networkApproved: true` on that call.
- Unsafe host execution does not exist in V5. An unsafe policy request is
  rejected before dispatch; container mode requires a real OCI backend.
- The process environment is rebuilt from an allowlist. Secret-looking keys
  are rejected and configured secret values are redacted from responses.
- The current Node process is never an implicit toolchain. Product composition
  binds the canonical bundled Node executable explicitly; Node toolchains have
  an exact-file execution root and cannot add their directory to `PATH`.
- Write roots must be contained by a declared read root. `.git` and `.agent`
  remain read-only in both native backends; Windows refuses a containing write
  grant when a protected path does not yet exist.
- Process handles belong to one broker instance. A broken connection makes
  them lost; they are never replayed after recovery.

The Linux required backend uses bubblewrap, kernel namespaces, Landlock,
`no_new_privs`, a deny-dangerous-syscalls seccomp filter, and native
`forkpty`. The Windows backend uses per-command AppContainer identities and
ACLs, Job Object
process-tree containment, capability-gated networking, and ConPTY. Windows
requires a one-time `agent sandbox setup`; readiness is reported only after
filesystem, network, process-containment, and ConPTY self-tests pass.
