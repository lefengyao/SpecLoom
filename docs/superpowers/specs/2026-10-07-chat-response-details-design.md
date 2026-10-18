# Chat Response Details Design

## Behavior

Completed assistant replies show the final answer as the primary content. Thinking and tool activity are grouped at the top of the assistant reply and collapsed by default. A control in that header expands the details for the current reply. During an active run, the current activity remains visible.

The personalization settings expose independent switches for hiding the details block and showing output rate, first-token latency, and thinking duration. Detail hiding and all three metrics default to enabled. Metrics are persisted with assistant messages so they remain available after reopening a session; older messages without metrics simply omit them.

## Data Flow

The runtime records run start, first streamed model content, thinking intervals, and completed output length. Session persistence attaches the resulting response metrics to assistant message items. The renderer groups each turn's thinking/tool/activity items with its final assistant message, rendering them inside one reply bubble.

## Validation

Tests cover preference normalization and persistence, metric calculation/persistence, default collapsed details and manual expansion, independent metric visibility switches, and compatibility with older sessions.
