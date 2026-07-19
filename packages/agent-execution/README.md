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
- Write roots must be contained by a declared read root. `.agent` remains
  protected; native host execution also protects `.git`. Windows refuses a
  containing write grant when a protected path does not yet exist.
- Process handles belong to one broker instance. A broken connection makes
  them lost; they are never replayed after recovery.
- Container mode accepts only a broker created by the product's trusted
  launcher. Managed selectors and attestations are launcher-only inputs; CLI
  and workspace configuration can choose `auto|docker|podman` and
  `owned|managed`, but cannot name an engine target. Engine, target start
  identity, and image identity are pinned and re-attested before every
  operation. A missing backend reports `container_unavailable`; a stale or
  mismatched target reports `container_attestation_invalid`.

The packaged managed-container client discovers only the fixed product
boundary `/run/sigma-oci/broker.sock`. The adjacent root-owned,
non-writable `/run/sigma-oci/attestation.json` uses
`TrustedManagedContainerAttestationV1`; its `attestationDigest` is SHA-256 of
compact UTF-8 JSON with keys in this exact order:
`protocolVersion,engine,selector,targetId,targetStartedAt,imageId,imageDigest,labelsDigest`.
`imageDigest` is JSON `null` when absent. The socket speaks the same four-byte
big-endian framed protocol as `sigma-exec`, and output spool directories live
under `/run/sigma-oci/artifacts/sigma-exec-artifacts-*`. None of these paths or
the managed selector can be overridden by flags, environment, or workspace
configuration.

Generic Linux `owned` mode discovers only the fixed Docker socket
`/var/run/docker.sock` or fixed Podman sockets under `/run/podman` and the
current UID's `/run/user/<uid>/podman`; socket paths are not configurable. It
requires a pre-existing immutable `name@sha256:<digest>` image, creates one
randomly named container, and bind-mounts the workspace at the same absolute
path. The packaged `sigma-exec` and pinned bubblewrap helper are mounted
read-only; `sigma-exec` runs as PID 1. The target receives no control
environment or model credentials. The container retains `SYS_ADMIN` only so
the trusted helper can construct its nested bubblewrap boundary; the hardened
launcher drops all capabilities before user code runs. Container
ID, start time, image ID/digest, proof labels, mounts, and network boundary are
checked before use and re-attested throughout the run. `none` and `loopback`
use the target's isolated `none` network namespace; `full` uses an engine
bridge and remains subject to normal network approval. Provisioning failures
remove by the unique name when the returned ID is unknown, while disconnects,
identity changes, and normal close force-remove the exact owned target and its
artifact spool; provisioning cancellation follows the same
cleanup path. Per-command cancellation remains contained by `sigma-exec` so a
healthy owned target can continue the run. There is no host-execution fallback.

The Linux required backend uses bubblewrap, kernel namespaces, Landlock,
`no_new_privs`, a deny-dangerous-syscalls seccomp filter, and native
`forkpty`. The Windows backend uses per-command AppContainer identities and
ACLs, Job Object
process-tree containment, capability-gated networking, and ConPTY. Windows
requires a one-time `agent sandbox setup`; readiness is reported only after
filesystem, network, process-containment, and ConPTY self-tests pass.
