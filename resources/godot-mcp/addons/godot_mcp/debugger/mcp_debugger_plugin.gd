## MCP Debugger Plugin — EditorDebuggerPlugin subclass.
## Registered via EditorPlugin.add_debugger_plugin() in plugin.gd's _enter_tree().
## Manages debugger sessions, breakpoint sync, and async message capture
## for the debugging_commands module.
@tool
class_name MCPDebuggerPlugin
extends EditorDebuggerPlugin

## Reference to the debugging commands module (for callbacks)
var _debugging_commands: RefCounted = null

## Pending breakpoints — synced when a game session becomes active.
## {key: {path, line, condition, enabled}}
var _pending_breakpoints: Dictionary = {}

## Last call stack data (populated by _capture)
var last_call_stack: Array = []
var is_paused: bool = false

## Active session reference
var _active_session: EditorDebuggerSession = null

## Promise-like signal for async debugger responses (evaluate, stack dump)
signal evaluation_result(value: Variant)
signal stack_dump_received(frames: Array)

## Accumulated evaluation result (set by _capture, consumed by wait loop)
var _eval_result: Variant = null

const GAME_SCREENSHOT_TIMEOUT_MSEC: int = 10_000
const MAX_GAME_SCREENSHOT_BASE64_CHARS: int = 11_184_812
const MAX_GAME_SCREENSHOT_CHUNK_CHARS: int = 256 * 1024
const MAX_GAME_SCREENSHOT_CHUNKS: int = 43

## In-flight game screenshots, keyed by request id. Results and chunks are
## received independently through the debugger capture and assembled here.
var _pending_game_screenshots: Dictionary = {}


## Called automatically by the engine when a new session is created.
## Sessions are created once at editor start and may be reactivated on game launch.
func _setup_session(session_id: int) -> void:
	var session := get_session(session_id)
	if session == null:
		return

	session.started.connect(_on_session_started.bind(session))
	session.stopped.connect(_on_session_stopped.bind(session))
	session.breaked.connect(_on_session_breaked.bind(session))
	session.continued.connect(_on_session_continued.bind(session))
	print("[MCP Debugger] Session %d setup complete" % session_id)


func _on_session_started(session: EditorDebuggerSession) -> void:
	print("[MCP Debugger] Session started — game connected, syncing breakpoints")
	_active_session = session
	_sync_pending_breakpoints(session)


func _on_session_stopped(session: EditorDebuggerSession) -> void:
	print("[MCP Debugger] Session stopped — game disconnected")
	for request_id: String in _pending_game_screenshots:
		var pending: Dictionary = _pending_game_screenshots[request_id]
		if pending.get("session") == session and not pending.get("done", false):
			pending["done"] = true
			pending["error"] = "Game stopped while waiting for screenshot"
			pending["chunks"] = PackedStringArray()
			pending["received_count"] = 0
			_pending_game_screenshots[request_id] = pending
	if _active_session == session:
		_active_session = null
		is_paused = false
		last_call_stack.clear()


func _on_session_breaked(can_debug: bool, session: EditorDebuggerSession) -> void:
	print("[MCP Debugger] Breakpoint hit — can_debug=%s" % can_debug)
	if can_debug:
		is_paused = true
		# Auto-request stack dump so last_call_stack is populated
		session.send_message("get_stack_dump", [])
	else:
		# Auto-continue non-debuggable breaks to prevent IPC deadlock.
		# Dynamically-loaded scripts (e.g., execute_game_script temp scripts)
		# trigger can_debug=false breaks — resume immediately since nothing
		# can be inspected.
		session.send_message("continue", [])


func _on_session_continued(session: EditorDebuggerSession) -> void:
	print("[MCP Debugger] Execution continued")
	is_paused = false
	last_call_stack.clear()


## Sync stored breakpoints to a newly active session.
func _sync_pending_breakpoints(session: EditorDebuggerSession) -> void:
	if _pending_breakpoints.is_empty():
		return
	print("[MCP Debugger] Syncing %d pending breakpoints to session" % _pending_breakpoints.size())
	for key: String in _pending_breakpoints:
		var bp: Dictionary = _pending_breakpoints[key]
		session.set_breakpoint(bp.path, bp.line, bp.enabled)
	# Clear pending — they are now tracked by the engine
	_pending_breakpoints.clear()


## Queue a breakpoint to be synced when a session becomes active.
func queue_breakpoint(path: String, line: int, condition: String, enabled: bool = true) -> void:
	var key: String = "%s:%d" % [path, line]
	_pending_breakpoints[key] = {
		"path": path,
		"line": line,
		"condition": condition,
		"enabled": enabled,
	}
	# Also apply immediately if session is active
	if _active_session and _active_session.is_active():
		_active_session.set_breakpoint(path, line, enabled)


## Remove a queued breakpoint.
func unqueue_breakpoint(path: String, line: int) -> void:
	var key: String = "%s:%d" % [path, line]
	_pending_breakpoints.erase(key)
	if _active_session and _active_session.is_active():
		_active_session.set_breakpoint(path, line, false)


## Get the first active session, or null.
func get_active_session() -> EditorDebuggerSession:
	# Prefer cached active session
	if _active_session and _active_session.is_active():
		return _active_session
	# Fallback: scan all sessions
	for s in get_sessions():
		if s is EditorDebuggerSession and s.is_active():
			_active_session = s
			return s
	return null


## Capture messages from the game process.
## Handles stack_dump, stack_frame_vars, and custom MCP messages.
func _has_capture(prefix: String) -> bool:
	return prefix == "mcp" or prefix == "debugger"


func _capture(message: String, data: Array, session_id: int) -> bool:
	if message == "mcp:screenshot_result" or message == "screenshot_result":
		_handle_game_screenshot_result(data, session_id)
		return true
	if message == "mcp:screenshot_chunk" or message == "screenshot_chunk":
		_handle_game_screenshot_chunk(data, session_id)
		return true

	match message:
		"stack_dump":
			_handle_stack_dump(data)
			return true
		"stack_frame_vars":
			# Frame vars come as one summary + individual "stack_frame_var" messages
			# Store them for retrieval
			return true
		"mcp:eval_result":
			_eval_result = data[0]
			evaluation_result.emit(data[0])
			return true
		_:
			return false


## Ask the active game debugger session to capture a screenshot and wait for
## the complete in-memory PNG response.
func request_game_screenshot(request_id: String) -> Dictionary:
	if request_id.is_empty():
		return {"success": false, "error": "Screenshot request id cannot be empty"}
	if _pending_game_screenshots.has(request_id):
		return {"success": false, "error": "A screenshot request with this id is already pending"}
	if not _pending_game_screenshots.is_empty():
		return {"success": false, "error": "Another game screenshot request is already pending"}

	var session: EditorDebuggerSession = get_active_session()
	if session == null or not session.is_active():
		return {"success": false, "error": "Game is not running or its debugger session is unavailable"}

	var main_loop: SceneTree = Engine.get_main_loop() as SceneTree
	if main_loop == null:
		return {"success": false, "error": "Cannot wait for a game screenshot outside the editor scene tree"}

	_pending_game_screenshots[request_id] = {
		"session": session,
		"done": false,
		"error": "",
		"width": 0,
		"height": 0,
		"chunk_count": 0,
		"received_count": 0,
		"metadata_received": false,
		"chunks": PackedStringArray(),
		"image_base64": "",
	}
	session.send_message("mcp:capture_screenshot", [request_id])

	var deadline_msec: int = Time.get_ticks_msec() + GAME_SCREENSHOT_TIMEOUT_MSEC
	while _pending_game_screenshots.has(request_id):
		var pending: Dictionary = _pending_game_screenshots[request_id]
		if pending.get("done", false):
			_pending_game_screenshots.erase(request_id)
			if not pending.get("error", "").is_empty():
				return {"success": false, "error": pending["error"]}
			return {
				"success": true,
				"target": "game",
				"width": pending["width"],
				"height": pending["height"],
				"image_base64": pending["image_base64"],
			}

		if Time.get_ticks_msec() >= deadline_msec:
			pending["done"] = true
			pending["error"] = "Timed out after 10 seconds waiting for the game screenshot"
			pending["chunks"] = PackedStringArray()
			pending["received_count"] = 0
			_pending_game_screenshots[request_id] = pending
			continue
		await main_loop.process_frame

	return {"success": false, "error": "Screenshot request was cancelled"}


## Mark unfinished screenshot requests as failed before removing the debugger
## plugin. Waiters consume the error and release their own request state.
func cancel_pending_game_screenshots(reason: String) -> void:
	for request_id: String in _pending_game_screenshots:
		var pending: Dictionary = _pending_game_screenshots[request_id]
		if not pending.get("done", false):
			pending["done"] = true
			pending["error"] = reason
			pending["chunks"] = PackedStringArray()
			pending["received_count"] = 0
			_pending_game_screenshots[request_id] = pending


func _handle_game_screenshot_result(data: Array, session_id: int) -> void:
	if data.is_empty() or not data[0] is String:
		return
	var request_id: String = data[0]
	if request_id.is_empty():
		return
	if not _pending_game_screenshots.has(request_id):
		return
	var pending: Dictionary = _pending_game_screenshots[request_id]
	if pending.get("done", false) or pending.get("session") != get_session(session_id):
		return
	if pending.get("metadata_received", false):
		_fail_game_screenshot_request(request_id, "Game returned duplicate screenshot metadata")
		return

	if data.size() != 6:
		_fail_game_screenshot_request(request_id, "Game returned malformed screenshot metadata")
		return
	if not data[1] is bool or not data[2] is int or not data[3] is int or not data[4] is int or not data[5] is String:
		_fail_game_screenshot_request(request_id, "Game returned malformed screenshot metadata")
		return
	if not data[1]:
		var error_message: String = data[5]
		if error_message.is_empty():
			error_message = "Game failed to capture a screenshot"
		_fail_game_screenshot_request(request_id, error_message)
		return

	var width: int = data[2]
	var height: int = data[3]
	var chunk_count: int = data[4]
	if width <= 0 or height <= 0 or chunk_count <= 0 or chunk_count > MAX_GAME_SCREENSHOT_CHUNKS:
		_fail_game_screenshot_request(request_id, "Game returned invalid screenshot dimensions or chunk count")
		return

	var chunks: PackedStringArray = []
	chunks.resize(chunk_count)
	pending["width"] = width
	pending["height"] = height
	pending["chunk_count"] = chunk_count
	pending["chunks"] = chunks
	pending["received_count"] = 0
	pending["metadata_received"] = true
	_pending_game_screenshots[request_id] = pending


func _handle_game_screenshot_chunk(data: Array, session_id: int) -> void:
	if data.is_empty() or not data[0] is String:
		return
	var request_id: String = data[0]
	if request_id.is_empty():
		return
	if not _pending_game_screenshots.has(request_id):
		return
	var pending: Dictionary = _pending_game_screenshots[request_id]
	if pending.get("done", false) or pending.get("session") != get_session(session_id):
		return
	if data.size() != 3:
		_fail_game_screenshot_request(request_id, "Game returned a malformed screenshot chunk")
		return
	if not data[1] is int or not data[2] is String:
		_fail_game_screenshot_request(request_id, "Game returned a malformed screenshot chunk")
		return
	if not pending.get("metadata_received", false):
		_fail_game_screenshot_request(request_id, "Game screenshot chunk arrived before its metadata")
		return

	var chunk_index: int = data[1]
	var chunk: String = data[2]
	var chunks: PackedStringArray = pending["chunks"]
	if chunk_index < 0 or chunk_index >= chunks.size() or chunk.is_empty() or chunk.length() > MAX_GAME_SCREENSHOT_CHUNK_CHARS:
		_fail_game_screenshot_request(request_id, "Game returned an invalid screenshot chunk")
		return
	if not chunks[chunk_index].is_empty():
		_fail_game_screenshot_request(request_id, "Game returned a duplicate screenshot chunk")
		return

	chunks[chunk_index] = chunk
	pending["chunks"] = chunks
	pending["received_count"] = int(pending["received_count"]) + 1
	if pending["received_count"] == pending["chunk_count"]:
		var image_base64: String = "".join(chunks)
		if image_base64.is_empty() or image_base64.length() > MAX_GAME_SCREENSHOT_BASE64_CHARS or image_base64.length() % 4 != 0:
			_fail_game_screenshot_request(request_id, "Game returned an invalid screenshot payload")
			return
		pending["image_base64"] = image_base64
		pending["chunks"] = PackedStringArray()
		pending["received_count"] = 0
		pending["done"] = true
	_pending_game_screenshots[request_id] = pending


func _fail_game_screenshot_request(request_id: String, error_message: String) -> void:
	if not _pending_game_screenshots.has(request_id):
		return
	var pending: Dictionary = _pending_game_screenshots[request_id]
	pending["done"] = true
	pending["error"] = error_message
	pending["chunks"] = PackedStringArray()
	pending["received_count"] = 0
	_pending_game_screenshots[request_id] = pending


## Parse a stack_dump response from the game debugger.
## Format: [frame_count * 3]  where each frame is [file, line, function]
func _handle_stack_dump(data: Array) -> void:
	last_call_stack.clear()
	if data.size() < 2:
		return
	# Godot sends total element count as first element
	var total_elements: int = data[0] as int
	var frame_count: int = total_elements / 3
	for i in range(frame_count):
		var idx: int = 1 + i * 3
		last_call_stack.append({
			"file": data[idx],
			"line": data[idx + 1],
			"function": data[idx + 2],
		})
	stack_dump_received.emit(last_call_stack)


## Send a stack frame variable request for a specific frame index.
func request_stack_frame_vars(frame: int, session_id: int = -1) -> void:
	var session: EditorDebuggerSession
	if session_id >= 0:
		session = get_session(session_id)
	else:
		session = get_active_session()
	if session and session.is_active():
		session.send_message("get_stack_frame_vars", [frame])


## Send an evaluate request to the running game (breakpoint required).
func request_evaluate(expression: String, frame: int = 0) -> void:
	_eval_result = null
	var session := get_active_session()
	if session and session.is_active() and session.is_breaked():
		session.send_message("evaluate", [expression, frame])
