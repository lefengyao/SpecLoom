import { afterEach } from "vitest";
import { godotMcpHostRegistry } from "../src/main/core/godot-mcp/host-registry";

// ProjectCore opens project-scoped loopback listeners; clear any unclosed fixture after each case.
afterEach(async () => { await godotMcpHostRegistry.closeAll(); });
