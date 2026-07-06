import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import type { SessionAppendable } from "./types.js";

export class JsonlSessionStore {
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
  }

  async append(record: SessionAppendable): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
  }
}
