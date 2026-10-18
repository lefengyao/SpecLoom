# Context Usage Accuracy Repair

The user reports a long-running session remaining at roughly 10–19% context usage.

Observed causes: request history was silently capped at 96 messages / 262144 JSON characters before the 90% model-context compression trigger; the UI labeled accumulated run input as current actual context. The user's configured window is 1048576 tokens, so the old storage cap alone can pin displayed occupancy near 14%.

- [x] Preserve large-window request history across turns/restart with explicit bounded storage and semantic compression before storage limits.
- [x] Calibrate context estimates and output budgets from the latest individual provider request; keep cumulative billing usage separate.
- [x] Publish live checkpoint / usage snapshots and distinguish current context, latest request, and accumulated run usage in the UI.
- [x] Validate regression tests, complete TypeScript checks, focused lint and the running source runtime. Preserve existing edits; do not package.

Verified on 2026-10-15:

- Durable request history now permits 4096 messages / 4,194,304 JSON characters; session files permit 16 MiB. Compression triggers at 90% of either the model input budget or durable history capacity and targets 68%, retaining complete tool exchanges and the current user goal.
- Latest successful request usage calibrates subsequent estimates; missing, zero and invalid input usage cannot replace a valid sample. Anthropic cached input classes count toward input; OpenAI cache metadata is not double-counted. Compression and model changes invalidate samples.
- SessionRuns publishes checkpoint and request usage snapshots immediately, rejects guidance/checkpoint/result overflow instead of silently removing old history, and serializes concurrent guidance admission.
- Regression tests included verified red/green cases for live publication, latest versus accumulated usage, restart calibration, old history caps, provider cache input and guidance overflow. Final joint run: 29 files, 418 tests passed with `--maxWorkers=4`; full TypeScript checks, focused ESLint and `git diff --check` passed. An earlier unrestricted parallel run hit a one-second pre-existing capabilities wait timeout; its isolated rerun and the bounded final run passed without changing production code or weakening assertions.
- Source Electron window responds, renderer HTTP returns 200 and serves the latest context UI; nine main-process source-map entries match current disk sources. No package or release artifact was produced.

Existing histories already removed by the old retention logic are not automatically reconstructed. Same profile/model with an edited endpoint can temporarily reuse its prior sample until the next successful request refreshes it; model/provider switches explicitly clear the old estimate and sample.
