#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectLinuxElf } from "./linux-elf.mjs";
import {
  bubblewrapRelease,
  linuxBrokerBuilderImage,
  linuxCompatibilityImage,
  linuxMinimumGlibc,
  linuxRuntimeLibraryNames,
  linuxSysrootImage,
  patchelfRelease
} from "./linux-portable-runtime-config.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(rootDir, ".artifacts", "linux-portable-runtime");

function run(command, args, label) {
  const result = spawnSync(command, args, { cwd: rootDir, encoding: "utf8", stdio: "pipe" });
  if (result.error || result.status !== 0) {
    throw new Error([
      `${label} failed (exit=${String(result.status)}).`,
      result.stdout || "",
      result.stderr || result.error?.message || ""
    ].filter(Boolean).join("\n"));
  }
  return result;
}

function dockerMount(source, target, readOnly = false) {
  return `type=bind,source=${path.resolve(source)},target=${target}${readOnly ? ",readonly" : ""}`;
}

function verifyDocker() {
  run("docker", ["version", "--format", "{{.Server.Version}}"],
    "Linux portable runtime packaging requires a running Docker engine");
}

async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function build() {
  verifyDocker();
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  if (!process.env.SIGMA_EXEC_BINARY) {
    run("docker", [
      "run", "--rm", "--platform", "linux/amd64",
      "--mount", dockerMount(rootDir, "/workspace", true),
      "--mount", dockerMount(outputDir, "/out"),
      "-w", "/workspace", linuxBrokerBuilderImage, "sh", "-c",
      [
        "set -eu",
        "cargo build --release --locked --manifest-path native/sigma-exec/Cargo.toml --target x86_64-unknown-linux-musl --target-dir /out/cargo",
        "mkdir -p /out/bin",
        "cp /out/cargo/x86_64-unknown-linux-musl/release/sigma-exec /out/bin/sigma-exec",
        "chmod 0755 /out/bin/sigma-exec"
      ].join(" && ")
    ], "static musl sigma-exec build");
  }

  run("docker", [
    "run", "--rm", "--platform", "linux/amd64",
    "--mount", dockerMount(outputDir, "/out"),
    linuxSysrootImage, "sh", "-c",
    [
      "set -eu",
      "mkdir -p /out/lib /out/tools",
      "cp -L /usr/lib/x86_64-linux-gnu/libatomic.so.1 /out/lib/libatomic.so.1",
      "cp -L /usr/lib/x86_64-linux-gnu/libstdc++.so.6 /out/lib/libstdc++.so.6",
      "cp -L /usr/lib/gcc/x86_64-linux-gnu/8/libgcc_s.so.1 /out/lib/libgcc_s.so.1",
      `curl -fsSL ${patchelfRelease.url} -o /tmp/patchelf.tar.gz`,
      `printf '%s  %s\\n' ${patchelfRelease.sha256} /tmp/patchelf.tar.gz | sha256sum -c -`,
      "tar -xzf /tmp/patchelf.tar.gz -C /tmp",
      "cp /tmp/bin/patchelf /out/tools/patchelf",
      "chmod 0755 /out/tools/patchelf"
    ].join(" && ")
  ], "glibc 2.28 sysroot runtime extraction");

  run("docker", [
    "run", "--rm", "--platform", "linux/amd64",
    "--mount", dockerMount(outputDir, "/out"),
    linuxCompatibilityImage, "sh", "-c",
    [
      "set -eu",
      `curl -fsSL ${bubblewrapRelease.url} -o /tmp/bubblewrap.rpm`,
      `printf '%s  %s\\n' ${bubblewrapRelease.sha256} /tmp/bubblewrap.rpm | sha256sum -c -`,
      "rpm --import /etc/pki/rpm-gpg/RPM-GPG-KEY-rockyofficial",
      "rpm --checksig /tmp/bubblewrap.rpm",
      "mkdir -p /tmp/bwrap-root /out/bin /out/lib",
      "rpm --root /tmp/bwrap-root --initdb",
      "rpm --root /tmp/bwrap-root -i --nodeps /tmp/bubblewrap.rpm",
      "cp /tmp/bwrap-root/usr/bin/bwrap /out/bin/bwrap",
      "cp -L /lib64/libselinux.so.1 /out/lib/libselinux.so.1",
      "cp -L /lib64/libcap.so.2 /out/lib/libcap.so.2",
      "cp -L /lib64/libpcre2-8.so.0 /out/lib/libpcre2-8.so.0",
      "/out/tools/patchelf --set-rpath '$ORIGIN/../lib' /out/bin/bwrap",
      "chmod 0755 /out/bin/bwrap"
    ].join(" && ")
  ], "pinned bubblewrap runtime extraction");

  const libraries = [];
  for (const name of linuxRuntimeLibraryNames) {
    const filePath = path.join(outputDir, "lib", name);
    const elf = await inspectLinuxElf(filePath);
    libraries.push({ name, soname: elf.soname ?? name, path: `lib/${name}`, sha256: await sha256(filePath) });
  }

  let broker = null;
  const brokerPath = path.join(outputDir, "bin", "sigma-exec");
  if (existsSync(brokerPath)) {
    await chmod(brokerPath, 0o755).catch(() => undefined);
    const elf = await inspectLinuxElf(brokerPath);
    if (elf.interpreters.length > 0 || elf.needed.length > 0) {
      throw new Error(`sigma-exec must be a static ELF without an interpreter; found interpreters=${elf.interpreters.join(",")} needed=${elf.needed.join(",")}.`);
    }
    broker = { path: "bin/sigma-exec", sha256: await sha256(brokerPath), linkage: "static-musl" };
  }
  const bubblewrapPath = path.join(outputDir, "bin", "bwrap");
  const bubblewrapElf = await inspectLinuxElf(bubblewrapPath);
  const sandbox = {
    name: "bubblewrap",
    version: bubblewrapRelease.version,
    path: "bin/bwrap",
    sha256: await sha256(bubblewrapPath),
    rpath: bubblewrapElf.runpath ?? bubblewrapElf.rpath,
    needed: bubblewrapElf.needed,
    maxGlibc: bubblewrapElf.maxGlibc
  };

  const metadata = {
    schemaVersion: 1,
    targetPlatform: "linux",
    targetArch: "x64",
    minimumGlibc: linuxMinimumGlibc,
    broker,
    sandbox,
    runtimeLibraries: libraries,
    builders: {
      broker: linuxBrokerBuilderImage,
      sysroot: linuxSysrootImage,
      compatibility: linuxCompatibilityImage,
      patchelf: patchelfRelease
    }
  };
  await writeFile(path.join(outputDir, "build-metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ outputDir, ...metadata }, null, 2)}\n`);
}

await build().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
