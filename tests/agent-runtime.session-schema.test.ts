import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listCurrentSessions
} from "../packages/agent-runtime/src/session-catalog.js";
import { SegmentedJsonlStore } from "../packages/agent-store/src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (item) => await rm(item, { recursive: true, force: true })));
});

describe("session store isolation boundary", () => {
  it("rejects an unknown store layout without modifying it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-unknown-store-read-only-"));
    roots.push(root);
    const unknownDirectory = path.join(root, "stores", "v999");
    const marker = path.join(unknownDirectory, "sessions", "session", "meta.json");
    await mkdir(path.dirname(marker), { recursive: true });
    await writeFile(marker, "unknown schema bytes\n", "utf8");
    const store = new SegmentedJsonlStore({ rootDir: root });

    await expect(listCurrentSessions(store, root, 20)).rejects.toMatchObject({
      code: "unsupported_store_layout",
      path: unknownDirectory,
      expected: 1,
      actual: "v999"
    });
    expect(await readFile(marker, "utf8")).toBe("unknown schema bytes\n");
    await expect(stat(path.join(root, "stores", "v1"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
