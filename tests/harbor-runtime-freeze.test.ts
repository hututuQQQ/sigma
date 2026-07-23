import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertFrozenHarborRuntimeUnchanged,
  snapshotFrozenHarborRuntime
} from "../scripts/harbor-runtime-freeze.mjs";

describe("frozen Harbor runtime integrity", () => {
  it("keeps a stable digest and detects arbitrary postflight additions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-harbor-runtime-"));
    await writeFile(path.join(root, "sigma_harbor_agent.py"), "VALUE = 1\n", "utf8");
    const before = await snapshotFrozenHarborRuntime(root);
    const unchanged = await snapshotFrozenHarborRuntime(root);
    expect(() => assertFrozenHarborRuntimeUnchanged(before, unchanged)).not.toThrow();

    await writeFile(path.join(root, "unexpected.txt"), "drift\n", "utf8");
    const changed = await snapshotFrozenHarborRuntime(root);
    expect(() => assertFrozenHarborRuntimeUnchanged(before, changed)).toThrow(/changed after launch preparation/u);
  });

  it("rejects Python bytecode caches before freezing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-harbor-cache-"));
    const cache = path.join(root, "__pycache__");
    await mkdir(cache, { recursive: true });
    await writeFile(path.join(cache, "agent.cpython-312.pyc"), "cache", "utf8");
    await expect(snapshotFrozenHarborRuntime(root)).rejects.toThrow(/Python cache state/u);
  });
});
