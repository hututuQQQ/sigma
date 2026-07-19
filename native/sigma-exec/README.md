# sigma-exec

`sigma-exec` is Sigma Code's process broker. It speaks a versioned, four-byte
big-endian length-prefixed JSON protocol over stdin/stdout. Stdout is reserved
for protocol frames; diagnostics go to stderr.

The broker fails closed. `sandbox: "required"` is accepted only after the
platform backend passes its self-test. Linux uses bubblewrap namespaces, an
in-namespace Landlock allowlist, `no_new_privs`, a deny-dangerous-syscalls
seccomp filter, and a native `forkpty` proxy. Its self-test independently
proves Landlock blocks a writable bind outside the declared write roots and
that seccomp is active; kernels below Landlock ABI 3 are rejected because they
cannot independently contain truncation. Declared file and directory roots
are mounted from pinned `O_PATH` descriptors; bubblewrap installations without
descriptor-bound bind support are rejected. The command working directory is
separately pinned and identity-attested before hardening and relative execution.
Any failure makes the backend unavailable. Windows
uses a per-command AppContainer identity,
workspace ACL capabilities, a kill-on-close Job Object, capability-gated
network access, and ConPTY for interactive background processes. Run
`agent sandbox setup` once per Windows user to create and verify the base
profile. A failed setup or self-test is never replaced with host execution.

V5 has no unsafe host-execution switch. Commands must use the native sandbox;
an OCI execution mode must be backed by a real container runtime or fail closed.
The native doctor report therefore advertises `container.available=false`.
Container-capable product launchers must supply a distinct OCI broker whose
doctor report includes the engine, ownership mode, target/container ID, start
identity, image ID/digest, and launcher-attestation digest. Higher layers pin
that identity and re-check it before every operation; a native broker is never
upgraded to container mode by a flag or workspace setting.
The product OCI bridge uses the existing framed protocol over the fixed Unix
socket `/run/sigma-oci/broker.sock`; native `sigma-exec` itself does not open an
engine socket or accept a managed target selector.
