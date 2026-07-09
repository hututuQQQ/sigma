#!/usr/bin/env node
export { runTuiApp, type TuiAppOptions } from "./v2/app.js";
export { TuiController, type TuiControllerOptions } from "./v2/controller.js";
export { createComposer, composerText, insertText, backspace, moveCursor, cellWidth } from "./v2/composer.js";
export { renderFrame } from "./v2/render.js";
export { createTuiState, reduceTui } from "./v2/state.js";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`agent tui [flags]\n\nThe TUI uses the same model, permission, workspace, and deadline flags as agent run.\n\nCommands:\n  /new                 Start a new session\n  /mode analyze|change Change mode for the next run\n  /followup <message>  Queue a request after the active answer\n  /quit                Exit\n\nCtrl+C cancels the active run; press it again within 1.5 seconds to exit.\n`);
    return 0;
  }
  process.stderr.write("Launch the TUI through the agent CLI so it can inject a configured RuntimeClient.\n");
  return 1;
}
