# Agent Chat Entry Design

## Problem

When a project has no selected task, SpecLoom only shows a “new task” button. The agent conversation composer is rendered only after a task exists, so the product does not present an obvious agent chat entry point.

## Design

The workspace always renders an agent conversation panel. With no selected task, the panel shows an empty conversation state, model selection, and a message composer. Submitting a message stores the draft in the renderer and opens the existing task-scope authorization dialog. Confirming the scope creates the task, selects it, and sends the stored message once. Cancelling leaves the draft in the composer and creates no task.

The existing task chat path remains unchanged. The new path never creates an implicit task or broadens read/write permissions. If no provider/model is configured, the composer offers a direct link to the provider page instead of enabling send.

## Data Flow

1. `WorkspaceView` calls `onStartConversation(model, prompt)` from the empty-state composer.
2. `App` stores the pending model and prompt, then opens `ScopeForm`.
3. After `workspace.createTask(scope)` resolves, `App` waits for the selected task and invokes `workspace.send(model, prompt)` exactly once.
4. Successful or failed sends clear the pending request; cancelling the scope keeps the draft visible.

## Validation

- Renderer test asserts the empty workspace exposes the chat composer and retains a draft while the scope dialog is open.
- Renderer test asserts confirming scope creates a task and sends the queued prompt with the chosen provider model.
- Existing task chat, provider configuration, typecheck, lint, full Vitest, Playwright, and application build remain passing.
