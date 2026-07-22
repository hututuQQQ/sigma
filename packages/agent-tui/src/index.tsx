#!/usr/bin/env node
export { runTuiApp, type TuiAppOptions } from "./components/app.js";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`agent tui [flags]\n\nThe TUI uses the same model, permission, workspace, and deadline flags as agent run. Use --initial-mode analyze|change to create the first session in the requested mode.\n\nCommands:\n  /new                 Start a new session\n  /mode analyze|change Start an idle session in another mode\n  /followup <message>  Queue work after the active answer\n  /activity            Collapse or expand activity\n  /help                Show shortcuts and commands\n  /quit                Exit\n\nEnter sends or steers. Shift+Enter/Ctrl+J adds a line. Alt+Enter queues a follow-up.\nCtrl+C cancels the active run; press it again within 1.5 seconds to exit.\n`);
    return 0;
  }
  process.stderr.write("Launch the TUI through the agent CLI so it can inject a configured RuntimeClient.\n");
  return 1;
}
