# SpecLoom 0.1.5

0.1.5 adds local model-request diagnostics for reproducing provider and streaming failures. Each logical model request receives a diagnostic ID; the session error shows that ID so it can be searched in Settings → Diagnostics. The log records request/response phases, safe status and media-type data, stream counters, retries, and terminal errors. It does not store prompts, replies, reasoning, tool arguments/results, credentials, or raw response bodies.

Diagnostics are stored as bounded JSONL under the application user-data directory. The default policy retains 30 days, caps each file at 5 MiB, and caps total storage at 25 MiB. The settings page supports filtering, event inspection, export, expired-log cleanup, and clear-all confirmation. In Trailblazer Hub, export asks for a destination folder and creates a timestamped JSONL file there.

The Hub module remains multi-instance and supports Trailblazer Hub 0.1.6 or later. Import `specloom-module-0.1.5.zip` from the Hub Downloads page, then launch SpecLoom from the Launch page.

## Verification

- `npm run typecheck` and `npm run lint`: passed.
- Focused diagnostics, IPC, renderer, session, and Hub-runtime tests: passed. The final packaging check ran 5 test files / 17 tests.
- The complete Vitest run remains non-green in this checkout: 101 files passed, 4 files had 8 failed tests, 5 were skipped, and one cancellation-related unhandled rejection was reported. The two `App.test.tsx` selector failures also occurred before the diagnostics changes; approval suites passed separately twice (14/14 and 4/4), and the race suite passed separately (6/6).
- Windows x64 builds completed. The 0.1.4 release directory and Hub module archive were preserved.

## Artifacts

| Artifact | Size | SHA-256 | Location |
| --- | ---: | --- | --- |
| Windows x64 setup | 118,764,811 bytes | `e6649eb19a1f1d90938ceea4506f913013af793c579cd7f2ade7dc5fe84a24be` | `release/0.1.5/SpecLoom-0.1.5-Setup-x64.exe` |
| Windows x64 portable | 167,710,518 bytes | `b08670e3024fdb5054412d2f690a14d5c21a9ce2262321c2de1381602c66f8d0` | `release/0.1.5/SpecLoom-0.1.5-Portable-x64.zip` |
| Trailblazer Hub module | 19,233,340 bytes | `98913b277f52db8c5b5567da0eb5e7f1f17b50ec8b2a30aa58956c73040b759c` | `../TraiblazerHub/exports/specloom-module-0.1.5.zip` |
