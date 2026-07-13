import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function resolveSigmaExecBinary(directory: string, platform: NodeJS.Platform = process.platform): string {
  return path.resolve(directory, platform === "win32" ? "sigma-exec.exe" : "sigma-exec");
}

/**
 * Resolve the Node executable from the portable package layout containing a
 * compiled workspace package module. Portable packages live at either
 * `packages/<name>/dist` or `node_modules/<name>/dist`, three levels below the
 * bundle root. A link is deliberately not accepted: the trusted toolchain must
 * name the regular file shipped in `bin`, not an indirection chosen at launch.
 */
export function resolvePortableNodeExecutable(
  packageModuleUrl: string | URL,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  try {
    const modulePath = fileURLToPath(packageModuleUrl);
    const bundleRoot = path.resolve(path.dirname(modulePath), "..", "..", "..");
    const canonicalBundleRoot = realpathSync.native(bundleRoot);
    if (!lstatSync(canonicalBundleRoot).isDirectory()) return undefined;

    const expectedBin = path.join(canonicalBundleRoot, "bin");
    const binStatus = lstatSync(expectedBin);
    if (!binStatus.isDirectory() || binStatus.isSymbolicLink()) return undefined;
    const canonicalBin = realpathSync.native(expectedBin);
    if (!sameFilesystemPath(canonicalBin, expectedBin)
      || !pathWithinRoot(canonicalBin, canonicalBundleRoot)) return undefined;

    const expectedExecutable = path.join(canonicalBin, platform === "win32" ? "node.exe" : "node");
    const executableStatus = lstatSync(expectedExecutable);
    if (!executableStatus.isFile() || executableStatus.isSymbolicLink()) return undefined;
    const canonicalExecutable = realpathSync.native(expectedExecutable);
    if (!sameFilesystemPath(canonicalExecutable, expectedExecutable)
      || !sameFilesystemPath(path.dirname(canonicalExecutable), canonicalBin)) return undefined;
    return canonicalExecutable;
  } catch {
    return undefined;
  }
}

function filesystemPathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function sameFilesystemPath(left: string, right: string): boolean {
  return filesystemPathKey(left) === filesystemPathKey(right);
}

function pathWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`)
    && relative !== ".."
    && !path.isAbsolute(relative));
}
