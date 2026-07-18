import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ContentAddressedArtifactStore,
  isSessionMetaV5,
  sessionDirectory
} from "../packages/agent-store/src/index.js";
import { atomicJson } from "../packages/agent-store/src/durable-file.js";

describe("durable store failure boundaries", () => {
  it("rejects non-object and array V5 metadata", () => {
    expect(isSessionMetaV5(null)).toBe(false);
    expect(isSessionMetaV5([])).toBe(false);
  });

  it("detects corruption when an existing CAS object is written again", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-cas-corrupt-"));
    const store = new ContentAddressedArtifactStore(root);
    const content = "expected";
    const digest = createHash("sha256").update(content).digest("hex");
    const artifactDirectory = path.join(sessionDirectory(root, "session"), "artifacts");
    await mkdir(artifactDirectory, { recursive: true });
    await writeFile(path.join(artifactDirectory, digest), "corrupt", "utf8");
    await expect(store.put("session", content)).rejects.toThrow(/corrupt/u);
  });

  it("does not retry a non-transient atomic replacement failure", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-atomic-json-"));
    let attempts = 0;
    await expect(atomicJson(path.join(root, "state.json"), { ok: true }, async () => {
      attempts += 1;
      throw Object.assign(new Error("permanent failure"), { code: "EINVAL" });
    })).rejects.toThrow(/permanent failure/u);
    expect(attempts).toBe(1);
  });
});
