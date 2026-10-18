# SpecLoom Godot MCP

SpecLoom bundles GodotMCP-Standalone 1.1.0 (plugin metadata 1.0.0) and serves its eight approved read-only tools through both the Agent and SpecLoom's authenticated inbound MCP endpoint. The addon targets Godot 4.x; runtime verification for this release targets Godot 4.7 or newer.

Open a Godot project, choose **Plugins → Install and enable**, and confirm the dialog. Confirmation copies the verified addon to `addons/godot_mcp/`, records per-file ownership in `.specloom-managed.json`, enables `res://addons/godot_mcp/plugin.cfg`, and removes only the exact settings owned by the retired SpecLoom screenshot bridge. Existing unrelated plugin entries and custom Autoload settings are preserved. Reload the project in Godot after installation or enable/disable changes. A disabled installed plugin also requires confirmation before Godot loads its scripts. Disabling leaves addon files in place.

The package contains the upstream MIT license and attribution notice. Installation verifies the bundled file manifest and hashes. It updates an existing file only when it matches the packaged release, the known upstream baseline, or the previous SpecLoom ownership marker. A different file, unsafe link/junction, unsupported project setting or bundle digest mismatch stops the operation and reports the affected path. SpecLoom never removes the project addon directory recursively.

The project addon selects only SpecLoom's `specloom` service. It scans the loopback WebSocket range `127.0.0.1:6505–6514`, then confirms both service identity and the normalized, exact project path before connecting. One bridge is shared for the same canonical project across Agent sessions, Trailblazer Hub windows and inbound MCP requests; separate projects use separate bridge instances. If the plugin was installed while Godot was already open, reload the project and refresh the plugin page. The card distinguishes installed/enabled state from a live Godot connection and can reveal the plugin directory.

Only these registered tools are exposed. Every request is schema-checked in SpecLoom before it reaches the addon.

| Tool | Godot route | Inputs |
| --- | --- | --- |
| `get_diagnostics` | `mcp/diagnostics` | `{}`; returns local bridge status and reconnect guidance when offline |
| `get_output_log` | `editor/get_output_log` | Optional `cursor` (1–2048 chars), `direction` (`older`/`newer`), `limit` (1–500, default 100), and up to five `levels` from ERROR/WARNING/INFO/DEBUG/UNKNOWN |
| `get_editor_screenshot` | `editor/get_screenshot` | `{}`; current editor viewport |
| `get_game_screenshot` | `editor/get_game_screenshot` | `{}`; running game viewport |
| `get_project_info` | `project/get_info` | `{}` |
| `get_scene_tree` | `scene/get_tree` | Optional `max_depth` from 0–64, default 15 |
| `get_game_scene_tree` | `runtime/get_scene_tree` | `{}` |
| `get_game_node_properties` | `runtime/get_node_properties` | Relative `path` (maximum 4096 chars, no traversal) and optional property names (up to 128) |

Screenshots are checked for canonical base64 PNG data, an 8 MiB byte limit and bounded dimensions. Agent calls pass them as images; inbound MCP returns an MCP image block plus separate dimensions text. The image bytes are not persisted in the project or written into diagnostic logs. Output-log pages are held in bounded, expiring snapshots so cursor paging refers to one consistent capture.

The existing official MCP listener remains loopback-only and requires its current Bearer token. Clients pass the normal task ID along with Godot tool arguments. See [MCP connection details](../mcp.md) for setup and authentication.

If diagnostics say the addon is disconnected, confirm that the same project is open in Godot, the SpecLoom plugin is enabled, and the project has been reloaded. If installation reports a file conflict, inspect the reported path before resolving it; SpecLoom deliberately leaves project-owned modifications intact. If none of the 6505–6514 ports can be opened, close the conflicting service and retry.
