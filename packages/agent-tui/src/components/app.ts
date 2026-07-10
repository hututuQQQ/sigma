import type { TuiControllerOptions } from "./controller.js";
import { TuiController } from "./controller.js";

export type TuiAppOptions = TuiControllerOptions;

export async function runTuiApp(options: TuiAppOptions): Promise<void> {
  const controller = new TuiController(options);
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
