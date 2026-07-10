import { TuiSessionController } from "./controller.js";
import type { TuiAppOptions } from "./types.js";

export type { TuiAppOptions } from "./types.js";

export async function runTuiApp(options: TuiAppOptions): Promise<void> {
  const controller = new TuiSessionController(options);
  const stop = (): void => controller.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await controller.run();
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
