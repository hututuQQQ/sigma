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
    possibleEffects: ["filesystem.read", "filesystem.write"],
    approval: "prompt"
  }
});
```

Policy is declared for the server boundary and is never inferred from a tool name. Every request gets a progress token, an idle timeout that only matching progress resets, an absolute deadline, and MCP cancellation on abort. `close()` first closes stdin and then terminates the complete process tree if the server does not exit during the grace period.
