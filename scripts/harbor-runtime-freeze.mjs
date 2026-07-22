import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import path from "node:path";

function portablePath(value) {
  return value.split(path.sep).join("/");
}

function pythonCachePath(relativePath) {
  return relativePath.split("/").includes("__pycache__") || relativePath.endsWith(".pyc");
}

async function collect(root, current, entries) {
  const children = await readdir(current, { withFileTypes: true });
  for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(current, child.name);
    const relative = portablePath(path.relative(root, absolute));
    if (pythonCachePath(relative)) {
      throw new Error(`Frozen Harbor runtime contains Python cache state: ${relative}`);
    }
    const info = await lstat(absolute);
    if (info.isDirectory()) {
      entries.push({ path: `${relative}/`, kind: "directory" });
      await collect(root, absolute, entries);
    } else if (info.isFile()) {
      const content = await readFile(absolute);
      entries.push({
        path: relative,
        kind: "file",
        size: content.length,
        sha256: createHash("sha256").update(content).digest("hex")
      });
    } else if (info.isSymbolicLink()) {
      entries.push({ path: relative, kind: "symlink", target: await readlink(absolute) });
    } else {
      throw new Error(`Frozen Harbor runtime contains unsupported filesystem entry: ${relative}`);
    }
  }
}

export async function snapshotFrozenHarborRuntime(runtimeDir) {
  const root = path.resolve(runtimeDir);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory()) throw new Error("Frozen Harbor runtime path is not a directory.");
  const entries = [];
  await collect(root, root, entries);
  const canonical = JSON.stringify(entries);
  return {
    schema_version: 1,
    digest: createHash("sha256").update(canonical).digest("hex"),
    entries
  };
}

export function assertFrozenHarborRuntimeUnchanged(before, after) {
  if (before?.digest !== after?.digest) {
    throw new Error(
      `Frozen Harbor runtime changed after launch preparation (${before?.digest ?? "missing"} -> ${after?.digest ?? "missing"}).`
    );
  }
}
