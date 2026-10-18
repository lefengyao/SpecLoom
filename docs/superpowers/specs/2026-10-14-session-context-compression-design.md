# Session Context Compression Design

## Goal

Automatically compress old agent context with the currently selected model when the effective input context reaches 90% of the model window. Preserve the visible chat history while storing a durable summary for future runs.

## Behavior

- Calculate usage against `contextTokens - reservedOutputTokens`.
- At 90% or higher, summarize older complete user/assistant/tool batches with the same configured model and no tools.
- Keep the system prompt, the current user goal, and the newest complete tool batches in full.
- Split oversized history at complete tool-batch boundaries. Summarize each chunk, then recursively summarize chunk summaries until the request fits below the target budget.
- Persist the resulting summary separately from visible `ChatSession.items` and reuse it after restart, export/import, and subsequent messages.
- On compression failure, continue with the existing context fitting behavior and preserve the original conversation.

## Boundaries

The summary is derived request context, not a replacement for visible history. It is redacted and bounded before persistence. Compression uses the active model profile, with a small output budget and no tools, and cannot recursively trigger compression.

## Verification

Unit tests cover the threshold, complete tool-batch preservation, chunking, recursive reduction, failure fallback, secret redaction, and summary reuse on the next request. Integration tests cover persistence across session reload and export/import.
