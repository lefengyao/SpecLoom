## Editor commands module - 9 tools.
## Handles errors, screenshots, editor script execution, and output.
@tool
class_name MCPEditorCommands
extends RefCounted

var _plugin: EditorPlugin
var _debugger_plugin: MCPDebuggerPlugin


func set_plugin(plugin: EditorPlugin) -> void:
	_plugin = plugin


func set_debugger_plugin(debugger_plugin: MCPDebuggerPlugin) -> void:
	_debugger_plugin = debugger_plugin


## Router compatibility: returns callable map for MCPCommandRouter.
func get_commands() -> Dictionary:
	return {
		"editor/get_errors": func(params: Dictionary) -> Dictionary: return execute("get_editor_errors", params),
		"editor/get_screenshot": func(params: Dictionary) -> Dictionary: return execute("get_editor_screenshot", params),
		"editor/get_game_screenshot": _get_game_screenshot,
		"editor/execute_script": func(params: Dictionary) -> Dictionary: return execute("execute_editor_script", params),
		"editor/clear_output": func(params: Dictionary) -> Dictionary: return execute("clear_output", params),
		"editor/get_signals": func(params: Dictionary) -> Dictionary: return execute("get_signals", params),
		"editor/reload_plugin": func(params: Dictionary) -> Dictionary: return execute("reload_plugin", params),
		"editor/reload_project": func(params: Dictionary) -> Dictionary: return execute("reload_project", params),
		"editor/get_output_log": func(params: Dictionary) -> Dictionary: return execute("get_output_log", params),
	}


## Main dispatcher.
func execute(method: String, params: Dictionary) -> Dictionary:
	match method:
		"get_editor_errors": return _get_editor_errors(params)
		"get_editor_screenshot": return _get_editor_screenshot(params)
		"execute_editor_script": return _execute_editor_script(params)
		"clear_output": return _clear_output()
		"get_signals": return _get_signals(params)
		"reload_plugin": return _reload_plugin()
		"reload_project": return _reload_project()
		"get_output_log": return _get_output_log()
	return {"success": false, "error": "Unknown method: " + method}


## Get editor errors by validating scripts on all nodes in the current scene.
func _get_editor_errors(params: Dictionary) -> Dictionary:
	var errors: Array = []
	var root: Node = _plugin.get_editor_interface().get_edited_scene_root()
	if root:
		_validate_scene_recursive(root, errors)
	return {"success": true, "errors": errors, "count": errors.size()}


func _validate_scene_recursive(node: Node, errors: Array) -> void:
	var scr: Script = node.get_script()
	if scr:
		if scr is GDScript:
			var gd: GDScript = scr as GDScript
			var err: Error = gd.reload(true)
			if err != OK:
				errors.append({
					"node": MCPCommandHelpers.get_node_path(node, _plugin),
					"script": scr.resource_path,
					"error": "Compilation error (code: %d)" % err,
				})
	for child: Node in node.get_children():
		_validate_scene_recursive(child, errors)


## Capture a screenshot of the editor viewport.
func _get_editor_screenshot(_params: Dictionary) -> Dictionary:
	# Capture the editor viewport in memory. This operation must not create files.
	var viewport: Viewport = _plugin.get_tree().get_root()
	if viewport == null:
		return {"success": false, "error": "Failed to get editor viewport"}
	var img: Image = viewport.get_texture().get_image()
	if img == null or img.is_empty():
		return {"success": false, "error": "Failed to capture editor viewport"}
	var png_bytes: PackedByteArray = img.save_png_to_buffer()
	if png_bytes.is_empty():
		return {"success": false, "error": "Failed to encode editor screenshot as PNG"}
	const MAX_PNG_BYTES: int = 8 * 1024 * 1024
	if png_bytes.size() > MAX_PNG_BYTES:
		return {"success": false, "error": "Editor screenshot PNG exceeds the 8 MiB size limit (%d bytes)" % png_bytes.size()}
	return {
		"success": true,
		"target": "editor",
		"image_base64": Marshalls.raw_to_base64(png_bytes),
		"width": img.get_width(),
		"height": img.get_height(),
	}


## Capture a screenshot of the running game viewport through debugger messages.
func _get_game_screenshot(_params: Dictionary) -> Dictionary:
	if not _plugin.get_editor_interface().is_playing_scene():
		return {"success": false, "error": "Game is not running"}
	if _debugger_plugin == null:
		return {"success": false, "error": "Godot MCP debugger plugin is unavailable"}

	var request_id: String = "mcp_game_screenshot_%d" % Time.get_ticks_usec()
	return await _debugger_plugin.request_game_screenshot(request_id)

## Execute arbitrary GDScript code in the editor context via EditorScript.
func _execute_editor_script(params: Dictionary) -> Dictionary:
	var code: String = params.get("code", "")
	if code.is_empty():
		return {"success": false, "error": "Code cannot be empty"}

	# Reject user-defined functions — they interact badly with the return-capture
	# wrapper that rewrites top-level `return` statements inside _run().
	for line: String in code.split("\n"):
		var trimmed: String = line.strip_edges()
		if trimmed.begins_with("func ") or trimmed.begins_with("static func "):
			return {"success": false, "error": "User-defined functions are not supported. Use inline code only."}

	# Normalize tabs to spaces to prevent "Mixed use of tabs and spaces"
	# compilation errors when user code uses tabs while the wrapper uses spaces.
	code = code.replace("\t", "    ")

	var script: GDScript = GDScript.new()
	var lines: PackedStringArray = code.split("\n")

	# Track whether user code contains a `return` statement so we can
	# distinguish "user returned null" from "no return statement".
	var has_return: bool = false

	# Wrap user code in a helper function for runtime-error isolation.
	# If user code crashes at runtime, _mcp_user_code() returns early
	# and _mcp_executed stays false, allowing us to detect runtime errors.
	#
	# CRITICAL: GDScript runtime errors (null access, array OOB, etc.) do NOT
	# propagate to the caller — the VM catches them internally, prints the error,
	# and returns a default value.  The caller (here: _run()) sees CALL_OK and
	# continues execution.  Therefore, _mcp_executed = true MUST be placed at the
	# END of _mcp_user_code() — NOT in _run() after the call.  If placed in
	# _run(), the flag is always set regardless of whether user code crashed.
	var wrapped_code: String = (
		"extends EditorScript\n\n"
		+ "var _mcp_return_value = null\n"
		+ "var _mcp_executed = false\n\n"
		+ "func _run() -> void:\n"
		+ "    _mcp_user_code()\n\n"
		+ "func _mcp_user_code() -> void:\n"
	)
	for line: String in lines:
		var trimmed: String = line.strip_edges()
		if trimmed == "return":
			# Bare return — valid in void function.
			# Do NOT set has_return = true: a bare return does not
			# produce a value, so the response should use "message",
			# not "result: null".
			# Set _mcp_executed BEFORE return so the sentinel is
			# reached — otherwise the early return skips the
			# completion marker at the end of the wrapper.
			wrapped_code += "    _mcp_executed = true\n"
			wrapped_code += "    return\n"
		elif trimmed.begins_with("return ") and trimmed.length() > 7:
			# Capture return value via class member, then return
			has_return = true
			wrapped_code += "    _mcp_return_value = " + trimmed.substr(7) + "\n"
			# Set _mcp_executed BEFORE return so the sentinel is
			# reached — otherwise the early return skips the
			# completion marker at the end of the wrapper.
			wrapped_code += "    _mcp_executed = true\n"
			wrapped_code += "    return\n"
		else:
			wrapped_code += "    " + line + "\n"
	# Signal completion: only reached if no runtime error occurred.
	# GDScript runtime errors cause this function to return early
	# (the VM handles the error internally), skipping this assignment.
	wrapped_code += "    _mcp_executed = true\n"
	script.source_code = wrapped_code

	var err: Error = script.reload(true)
	if err != OK:
		return {"success": false, "error": "Script compilation failed: %s" % error_string(err)}

	var editor_script: EditorScript = script.new() as EditorScript
	if editor_script == null:
		return {"success": false, "error": "Failed to create EditorScript instance"}
	editor_script._run()

	# Detect runtime errors: if _mcp_user_code() never completed,
	# _mcp_executed stays at its default (false).  This happens when
	# user code hits a runtime error (null access, invalid operation, etc.)
	# and GDScript halts execution inside the helper function.
	var executed: bool = editor_script.get("_mcp_executed") if editor_script.get("_mcp_executed") != null else false
	if not executed:
		return {"success": false, "error": "Script encountered a runtime error during execution. Check the editor output log for details."}

	var return_value: Variant = editor_script.get("_mcp_return_value")
	if has_return:
		return {"success": true, "result": return_value}
	return {"success": true, "message": "Editor script executed successfully"}


## Clear the editor output log.
##
## EditorLog::clear() is a C++ public method but is NOT exposed to GDScript
## (EditorLog is not registered with ClassDB), so has_method("clear") always
## returns false.  We cannot call it directly.
##
## The clear Button inside EditorLog triggers EditorLog::_clear_request() via
## its "pressed" signal.  However, the Button is buried inside a HBoxContainer
## toolbar, not a direct child of EditorLog.
##
## Instead, we find the RichTextLabel (which IS a built-in Godot class exposed
## to GDScript) inside EditorLog and call RichTextLabel.clear() on it directly.
## This clears the visible log display.  The internal messages buffer is NOT
## cleared, but since _get_output_log() reads from the RichTextLabel, the
## clearing is effective for our purposes.
##
func _clear_output() -> Dictionary:
	var editor_log: Node = _find_editor_log()
	if editor_log:
		var rich_text: RichTextLabel = MCPCommandHelpers.find_node_by_class(editor_log, "RichTextLabel") as RichTextLabel
		if rich_text:
			rich_text.clear()
			return {"success": true, "message": "Output cleared"}
		# RichTextLabel not found — try the Button approach as fallback
		var button: Button = MCPCommandHelpers.find_node_by_class(editor_log, "Button") as Button
		if button:
			button.emit_signal("pressed")
			return {"success": true, "message": "Output cleared"}
	# EditorLog not found — use the Script-tab refresh fallback
	_plugin.get_editor_interface().set_main_screen_editor("Script")
	return {"success": true, "message": "Output clear requested (fallback method)"}


## Get all signals on a node with their current connections.
func _get_signals(params: Dictionary) -> Dictionary:
	var node_path: String = params.get("node_path", "")
	if node_path.is_empty():
		return {"success": false, "error": "node_path is required"}
	var root: Node = _plugin.get_editor_interface().get_edited_scene_root()
	if root == null:
		return {"success": false, "error": "No scene open"}
	var node: Node = root.get_node_or_null(node_path)
	if node == null:
		return {"success": false, "error": "Node not found: %s" % node_path}

	var signals_data: Array = []
	var signal_list: Array = node.get_signal_list()
	for sig_info: Dictionary in signal_list:
		var sig_name: String = sig_info["name"] as String
		var connections: Array = node.get_signal_connection_list(sig_name)
		var conn_data: Array = []
		for conn: Dictionary in connections:
			# Filter: only show persistent connections (CONNECT_PERSIST = 2).
			# Editor-internal connections (flags=0 or editor-only flags) are
			# skipped to avoid noise from SceneTreeEditor bookkeeping connections.
			var flags: int = conn.get("flags", 0) as int
			if not (flags & 2):  # CONNECT_PERSIST
				continue
			var callable: Callable = conn["callable"] as Callable
			var target_obj: Object = callable.get_object()
			var target_desc: String = "(freed object)"
			if target_obj != null:
				target_desc = str(target_obj.get_path()) if target_obj is Node else str(target_obj)
			conn_data.append({
				"target": target_desc,
				"method": str(callable.get_method()),
			})
		signals_data.append({
			"name": sig_name,
			"args": sig_info.get("args", []),
			"connections": conn_data,
		})
	return {"success": true, "node": node_path, "signals": signals_data}


## Reload the MCP plugin by toggling it off and on.
func _reload_plugin() -> Dictionary:
	# Schedule reload for next frame so the response dict can be sent first.
	# Without call_deferred, set_plugin_enabled(false) tears down the plugin
	# (and its WebSocket) before the response reaches the client.
	var ei: EditorInterface = _plugin.get_editor_interface()
	ei.call_deferred("set_plugin_enabled", "godot_mcp", false)
	ei.call_deferred("set_plugin_enabled", "godot_mcp", true)
	return {"success": true, "message": "Plugin reloaded - connection will be re-established"}


## Rescan the project filesystem for changes.
func _reload_project() -> Dictionary:
	_plugin.safe_scan_filesystem()
	return {"success": true, "message": "Project filesystem rescanned"}


## Get the output log content from the editor's log panel.
func _get_output_log() -> Dictionary:
	# Read only the connected editor's Output panel. The MCP server owns parsing
	# and pagination; this command returns its raw visible text.
	var editor_log: Node = _find_editor_log()
	if editor_log == null:
		return {"success": false, "source": "editor_output", "error": "Could not read the connected editor Output panel: EditorLog was not found"}
	var rich_text: RichTextLabel = MCPCommandHelpers.find_node_by_class(editor_log, "RichTextLabel") as RichTextLabel
	if rich_text == null:
		return {"success": false, "source": "editor_output", "error": "Could not read the connected editor Output panel: RichTextLabel was not found"}
	if not rich_text.has_method("get_parsed_text"):
		return {"success": false, "source": "editor_output", "error": "Could not read the connected editor Output panel: parsed text is unavailable"}

	var content: String = rich_text.get_parsed_text()
	var history_truncated: bool = false
	var content_bytes: PackedByteArray = content.to_utf8_buffer()
	var first_byte: int = 0
	while content_bytes.size() - first_byte > 8 * 1024 * 1024:
		# Discard the oldest whole line. If the only remaining line is too large,
		# discard that complete line rather than returning a partial one.
		var newline_index: int = first_byte
		while newline_index < content_bytes.size() and content_bytes[newline_index] != 10:
			newline_index += 1
		if newline_index == content_bytes.size():
			first_byte = content_bytes.size()
		else:
			first_byte = newline_index + 1
		history_truncated = true
	if first_byte > 0:
		content = content_bytes.slice(first_byte).get_string_from_utf8()

	return {
		"success": true,
		"source": "editor_output",
		"content": content,
		"history_truncated": history_truncated,
	}


## Helper: find the EditorLog node by traversing the editor UI tree.
## The editor tree has ~22,000 descendants — deep recursion would overflow
## GDScript's stack.  Uses Godot's built-in find_children() with class filter,
## which is internally optimized and avoids all recursion/timeout issues.
func _find_editor_log() -> Node:
	var base: Node = _plugin.get_editor_interface().get_base_control()
	if base == null:
		return null
	var found: Array[Node] = base.find_children("*", "EditorLog", true, false)
	if not found.is_empty():
		return found[0]
	return null



