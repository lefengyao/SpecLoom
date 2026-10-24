import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "specloom-selftest", version: "1.0.0" });
server.tool("echo", "Echo the provided text.", { text: z.string() }, async ({ text }) => ({
  content: [{ type: "text", text: `echo:${text}` }],
}));
await server.connect(new StdioServerTransport());
