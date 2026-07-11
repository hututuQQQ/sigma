import path from "node:path";

export function resolveSigmaExecBinary(directory: string, platform: NodeJS.Platform = process.platform): string {
  return path.resolve(directory, platform === "win32" ? "sigma-exec.exe" : "sigma-exec");
}
