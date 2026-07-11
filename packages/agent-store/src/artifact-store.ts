import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { sessionDirectory } from "./paths.js";

export class ContentAddressedArtifactStore {
  constructor(private readonly rootDir: string) {}

  async put(sessionId: string, content: string | Uint8Array): Promise<string> {
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const directory = path.join(sessionDirectory(this.rootDir, sessionId), "artifacts");
    await mkdir(directory, { recursive: true });
    const target = path.join(directory, digest);
    await writeFile(target, bytes, { flag: "wx" }).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
      const existing = await readFile(target);
      if (createHash("sha256").update(existing).digest("hex") !== digest) {
        throw new Error(`Artifact CAS object '${digest}' is corrupt.`);
      }
    });
    return digest;
  }

  async get(sessionId: string, digest: string): Promise<Buffer> {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid artifact digest.");
    const content = await readFile(path.join(sessionDirectory(this.rootDir, sessionId), "artifacts", digest));
    if (createHash("sha256").update(content).digest("hex") !== digest) {
      throw new Error(`Artifact CAS object '${digest}' is corrupt.`);
    }
    return content;
  }
}
