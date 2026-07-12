import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface WindowsDirectoryLockHelperHandle {
  close(): Promise<void>;
}

const LOCK_HELPER = String.raw`
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import path from "node:path";

const INVALID_HANDLE = (1n << 64n) - 1n;
const ffi = createRequire(import.meta.url)("node:ffi");
const library = ffi.dlopen("kernel32.dll", {
  CreateFileW: {
    arguments: ["pointer", "uint32", "uint32", "pointer", "uint32", "uint32", "pointer"],
    return: "pointer"
  },
  GetFileInformationByHandleEx: {
    arguments: ["pointer", "uint32", "pointer", "uint32"], return: "int32"
  },
  CloseHandle: { arguments: ["pointer"], return: "int32" },
  GetLastError: { arguments: [], return: "uint32" }
});
const handles = [];
try {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const first = await lines[Symbol.asyncIterator]().next();
  if (first.done) throw new Error("Windows directory-lock helper received no path manifest.");
  const paths = JSON.parse(first.value);
  if (!Array.isArray(paths) || paths.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error("Windows directory-lock helper received an invalid path manifest.");
  }
  for (const target of paths) {
    const handle = library.functions.CreateFileW(
      Buffer.from(path.toNamespacedPath(target) + "\0", "utf16le"),
      0x0001,
      0x0001 | 0x0002,
      null,
      3,
      0x02000000 | 0x00200000,
      null
    );
    if (handle === INVALID_HANDLE) {
      throw new Error("Could not lock Windows directory " + JSON.stringify(target)
        + " (win32=" + library.functions.GetLastError() + ").");
    }
    const tag = Buffer.alloc(8);
    if (!library.functions.GetFileInformationByHandleEx(handle, 9, tag, tag.byteLength)) {
      library.functions.CloseHandle(handle);
      throw new Error("Could not inspect Windows directory " + JSON.stringify(target)
        + " (win32=" + library.functions.GetLastError() + ").");
    }
    if ((tag.readUInt32LE(0) & 0x0400) !== 0) {
      library.functions.CloseHandle(handle);
      throw new Error("Windows directory is a reparse point: " + target);
    }
    handles.push(handle);
  }
  process.stdout.write("ready\n");
  await new Promise((resolve) => process.stdin.once("end", resolve).once("close", resolve));
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  for (const handle of handles.reverse()) library.functions.CloseHandle(handle);
  library.lib.close();
}
`;

function exitPromise(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

function readinessPromise(
  child: ChildProcessWithoutNullStreams,
  paths: readonly string[],
  stderr: () => string
): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let settled = false;
    const timeout = setTimeout(() => reject(new Error(
      "Timed out while acquiring stable Windows directory handles."
    )), 10_000);
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      action();
    };
    const onData = (chunk: string): void => {
      stdout += chunk;
      if (stdout === "ready\n") settle(resolve);
      else if (!"ready\n".startsWith(stdout)) {
        settle(() => reject(new Error("Windows directory-lock helper returned an invalid handshake.")));
      }
    };
    const onError = (error: Error): void => settle(() => reject(error));
    const onExit = (code: number | null): void => settle(() => reject(new Error(
      `Windows directory-lock helper exited before readiness (${code ?? "signal"}): ${stderr().trim()}`
    )));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    child.stdin.write(`${JSON.stringify(paths)}\n`, (error) => {
      if (error) settle(() => reject(error));
    });
  });
}

export async function acquireWindowsDirectoryLockHelper(
  paths: readonly string[]
): Promise<WindowsDirectoryLockHelperHandle> {
  const child = spawn(process.execPath, ["--experimental-ffi", "--input-type=module", "--eval", LOCK_HELPER], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  const exited = exitPromise(child);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-16_384); });
  try {
    await readinessPromise(child, paths, () => stderr);
  } catch (error) {
    child.stdin.destroy();
    child.kill();
    await exited;
    throw error;
  }
  let closed = false;
  return {
    close: async () => {
      if (closed) return;
      closed = true;
      child.stdin.end();
      await exited;
      if (child.exitCode !== 0) {
        throw new Error(`Windows directory-lock helper failed while releasing handles: ${stderr.trim()}`);
      }
    }
  };
}
