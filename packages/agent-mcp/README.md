# agent-mcp

`agent-mcp` is Sigma's MCP boundary. It launches stdio servers without a shell, negotiates MCP, and exposes remote tools through the `agent-protocol` tool port.

```ts
import { McpStdioClient, McpToolBridge } from "agent-mcp";

const client = new McpStdioClient({
  name: "workspace-tools",
  command: "node",
  args: ["server.mjs"],
  cwd: workspace,
  timeouts: {
    idleTimeoutMs: 30_000,
    hardDeadlineMs: 120_000,
    shutdownGraceMs: 750
  }
});

await client.connect(signal);
const tools = await McpToolBridge.create(client, {
  namespace: "workspace",
  policy: {
    possibleEffects: ["filesystem.read"],
    approval: "prompt"
  }
});
```

Policy is declared explicitly for the server boundary and is never inferred from a tool name. V3 MCP servers are persistent read-only processes: `filesystem.write`, `destructive`, and `open_world` effects are rejected before spawn, and the broker always receives an empty `writeRoots` list. Every request gets a progress token, an idle timeout that only matching progress resets, an absolute deadline, and MCP cancellation on abort. `close()` terminates the complete process tree if the server does not exit during the grace period.
