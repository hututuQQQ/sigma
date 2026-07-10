import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

export interface RuntimeStateRootOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
}

function stateHome(options: RuntimeStateRootOptions): string {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? os.homedir();
  const platform = options.platform ?? process.platform;
  if (env.SIGMA_STATE_HOME) return path.resolve(env.SIGMA_STATE_HOME);
  if (platform === "win32") {
    return path.resolve(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "Sigma", "State");
  }
  if (platform === "darwin") return path.resolve(home, "Library", "Application Support", "Sigma", "State");
  return path.resolve(env.XDG_STATE_HOME ?? path.join(home, ".local", "state"), "sigma");
}

export function runtimeStateRoot(workspace: string, options: RuntimeStateRootOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const canonical = path.resolve(workspace);
  const identity = platform === "win32" ? canonical.toLowerCase() : canonical;
  const digest = createHash("sha256").update(identity).digest("hex");
  return path.join(stateHome(options), "workspaces", digest);
}
