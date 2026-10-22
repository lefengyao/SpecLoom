# SpecLoom Plugin SDK and Git Management Plugin — Design

**Date:** 2026-10-22

**Status:** Approved direction; implementation pending

## Goal

Extend the existing Godot-only plugin manager into a general SpecLoom plugin system. Ship an official built-in Git management plugin with a dedicated GUI page, while keeping the manifest and loader compatible with future server-distributed plugins.

## Decisions

- Plugins are **trusted local plugins**. They are not sandboxed and may use Node APIs from their main-process module.
- A plugin has an optional **main-process module** and one or more **standalone HTML renderer pages**.
- The first official plugin is `specloom-git`, enabled by default, implemented inside the repository and shipped as an extra resource.
- Git uses the system Git executable and the user's existing credential helper/SSH agent. SpecLoom does not store Git tokens.
- The first Git page covers status/diff/stage/commit, local branches, fetch/pull/push, and history/detail. It does not implement merge/rebase conflict resolution, force push, branch deletion, stash, tags, or remote management.

## Package Layout

```text
plugins/<plugin-id>/
  plugin.json
  main/index.mjs
  renderer/index.html
  renderer/app.js
  renderer/style.css
```

Built-in plugins live in `resources/plugins`. User plugins live in `<userData>/plugins`. The packaged application resolves built-ins from `process.resourcesPath/plugins`; development resolves them from `<appRoot>/resources/plugins`.

## Manifest

```json
{
  "id": "specloom-git",
  "name": "Git",
  "version": "0.1.0",
  "apiVersion": 1,
  "description": "Git status, staging, commits, branches, sync, and history.",
  "author": "SpecLoom",
  "official": true,
  "enabledByDefault": true,
  "main": "main/index.mjs",
  "contributes": {
    "pages": [
      {
        "id": "git",
        "title": "Git",
        "entry": "renderer/index.html",
        "icon": "git-branch"
      }
    ]
  },
  "permissions": ["project:read", "project:write", "git:read", "git:write", "git:network"]
}
```

Validation requirements:

- `id`: lowercase slug, 1–64 characters, unique.
- `apiVersion`: must equal the host's supported API version (1).
- Paths are relative, no `..`, no absolute paths, no symlink escape.
- At least one page or a main module is required.
- Duplicate plugin IDs or page IDs are rejected.
- A manifest error disables only that plugin and is shown in the manager.

## Main-Process Plugin API

A plugin main module exports:

```js
export async function activate(context) {
  context.commands.register("status", async (input, commandContext) => {
    return runGit(commandContext.projectPath, ["status", "--porcelain=v2"]);
  });
}

export async function deactivate() {}
```

`context` exposes:

- `commands.register(name, handler)`
- `projectPath()`
- `storage.get(key)` / `storage.set(key, value)`
- `log(message, details?)`
- `apiVersion`
- `pluginId`

Plugin main modules are loaded with dynamic `import(pathToFileURL(entry))`. They are trusted and can import Node built-ins. The host does not expose Electron objects directly; plugins that need host capabilities should expose commands rather than import Electron internals.

## Renderer Pages

Plugin pages are loaded in an iframe from a dedicated custom protocol:

```text
specloom-plugin://<plugin-id>/<page-id>
```

The protocol handler resolves only files declared by the enabled plugin's manifest. It rejects traversal, symlinks, disabled plugins, and unknown pages.

The host injects a small bridge using `postMessage`:

Request:

```js
parent.postMessage({
  channel: "specloom-plugin",
  type: "request",
  id: "1",
  method: "git.status",
  params: {}
}, "*");
```

Response:

```js
{
  channel: "specloom-plugin",
  type: "response",
  id: "1",
  ok: true,
  result: {}
}
```

Supported host methods:

- `project.get()` — current project path, name, engine.
- `plugin.invoke(command, params)` — call the plugin's registered main command with the current project path.
- `plugin.storage.get/set` — plugin-scoped JSON storage.
- `ui.openExternal(url)` — only `http:`/`https:` URLs, opened by the host.

The iframe is sandboxed with scripts/forms/same-origin allowed but no top navigation or popups. Since plugins are trusted, this is a UI containment boundary rather than a security sandbox.

## Plugin Manager

The existing plugin page becomes two sections:

1. **SpecLoom plugins** — built-in and user plugins, enable/disable, local install, uninstall, reveal directory, diagnostics.
2. **Godot project plugins** — the existing inventory and controls.

Manager state is stored in `<userData>/plugins-state.json`. Official built-ins default to enabled. User plugins default to disabled. Enabling a plugin activates its main module; disabling deactivates it and removes its pages.

Local installation now supports selecting a plugin folder. Server download later replaces the source adapter but keeps the manifest/install layout and enable-state model.

## Navigation

- Plugin pages appear in a separate “Plugin pages” navigation group.
- The official Git page appears as **Git** when the plugin is enabled and a project is open.
- Disabling the Git plugin removes the entry; if the user is currently on that page, navigation returns to the plugin manager.
- Existing Godot plugin management remains available for Godot projects.

## Official Git Plugin

### Main commands

- `git.state` — repository state, current branch, ahead/behind, remotes, changed-file summary.
- `git.diff` — working-tree or staged diff for one file with size limits.
- `git.stage` / `git.unstage` — stage or unstage selected paths.
- `git.commit` — commit staged changes with a message.
- `git.branches` — local branches and current branch.
- `git.createBranch` — create and switch to a branch.
- `git.switchBranch` — switch to an existing local branch.
- `git.fetch` / `git.pull` / `git.push` — sync using system credentials.
- `git.history` — bounded commit history.
- `git.commitDetail` — metadata and bounded diff for one commit.
- `git.init` — initialize a repository when absent.

All commands use `spawn("git", ...)` with:

- `GIT_TERMINAL_PROMPT=0`
- `GIT_OPTIONAL_LOCKS=0`
- `GIT_PAGER=cat`
- fixed timeouts and output limits
- no shell interpolation
- no stored credentials

Pull uses `--ff-only` and reports a clear error when a fast-forward is impossible. Push never forces. The UI provides confirmation for pull/push and destructive-looking actions, but stage/unstage/commit are direct.

### UI

Header:

- repository state
- current branch
- ahead/behind
- fetch / pull / push

Body:

- left: changed files with status and stage checkbox
- center: selected diff
- right: commit message and commit button
- tabs: branches and history

History:

- recent commits list
- selected commit metadata and diff

Empty states:

- not a repository: initialize button
- unavailable Git: install/configuration guidance
- no changes: clean working tree
- no commits: empty history

## Error Handling

- Manifest/load errors are isolated per plugin.
- Plugin command failures return a structured error through the bridge; the page shows an inline error and does not crash the host.
- Git failures preserve stderr, redact remote URL credentials, and map common cases (not a repo, no upstream, non-fast-forward, auth failure, unavailable Git).
- Deleting or disabling the active plugin page redirects to the plugin manager.
- Removing a plugin while a command is running waits for or aborts the command; commands are bounded by timeout.

## Testing

- Manifest validation and path traversal unit tests.
- Plugin enable/disable, activation, command invocation, storage, and uninstall tests with a temporary plugin.
- Custom protocol page resolution tests.
- Renderer plugin page bridge tests.
- Git command service tests with temporary repositories.
- Git page rendering/navigation tests.
- Existing Godot plugin tests remain unchanged.

## Out of Scope

- Sandboxed third-party execution.
- Server marketplace/download.
- Git merge/rebase conflict editing.
- Force push, branch deletion, stash, tags, remote CRUD.
- Storing Git credentials in SpecLoom.
