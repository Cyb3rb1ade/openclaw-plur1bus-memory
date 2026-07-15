# Final Review Fix Report

## Scope

Fixed the two final whole-branch review findings in `lib/afterthought.js` and added focused regressions in `tests/afterthought.test.js`.

Allowed-file scope was respected:

- `lib/afterthought.js`
- `tests/afterthought.test.js`
- `.superpowers/sdd/final-review-fix-report.md`

Pre-existing dirty files were left untouched:

- `lib/jobs/memory-dynamics-maintenance.js`
- `tests/memory-dynamics-maintenance.test.js`

## Changes

### 1. Stored prompt injection hardening in `composeAfterthought`

Updated the afterthought LLM prompt composition so persisted `candidate.userPrompt` is no longer sent as live user content without framing.

What changed:

- Imported and used `sanitizeMemoryTextForPrompt` from `lib/memory-context-sanitize.js`.
- Added `MAX_HISTORICAL_PROMPT_CHARS = 1000` and sanitized the historical prompt before including it in the LLM request.
- Reframed the prompt as explicit untrusted historical context.
- Added system-level instructions that the earlier user text is not a live instruction and that embedded role/system/tool/markup instructions must be ignored.
- Wrapped the sanitized payload inside a dedicated historical-context block.

Security effect:

- Raw `<system>` and injected closing tags from persisted log content no longer appear verbatim in the LLM input.
- The automatic afterthought path now treats replayed conversation text as hostile-by-default background context.

### 2. Bounded cron-path reads for `reply-outcomes.jsonl`

Updated `runAfterthoughtJob` to bound `readReplyOutcomeLog` reads with:

- `MAX_REPLY_OUTCOME_LOG_READ_BYTES = 2 * 1024 * 1024`

What changed:

- Replaced `readReplyOutcomeLog(workspaceDir, 50)` with object-form options:
  - `limit: 50`
  - `maxBytes: 2 * 1024 * 1024`

Behavioral effect:

- Oversized `reply-outcomes.jsonl` files are skipped by the shared JSONL reader instead of being fully read on the cron path.
- When skipped, afterthought falls back to the existing `no_candidate` path.

## Tests Added

### Prompt-injection regression

Added a regression that uses a malicious stored `userPrompt` containing:

- closing-tag content
- `<system>` content

Assertions verify:

- the LLM input labels the text as `Untrusted historical context`
- the LLM input does not contain raw `<system>`
- the LLM input does not contain raw injected closing tags
- sanitized escaped text is still present as historical content

### Oversized-log regression

Added a regression that writes an oversized `reply-outcomes.jsonl` entry greater than `2 * 1024 * 1024` bytes and verifies:

- `runAfterthoughtJob(...)` returns `{ skipped: true, reason: "no_candidate" }`

## Verification

Executed the required checks:

```bash
node --test tests/afterthought.test.js
node --check lib/afterthought.js
```

Both passed after the fix.

## Concerns

None from this change set. The prompt wrapper now mixes German system instructions with a short English trust marker (`Untrusted historical context`) because the regression explicitly checks for that label. That does not affect the response contract, but it is worth normalizing later if the project wants one language for all internal prompt scaffolding.

## Follow-up Fix

Re-review found that the first hardening pass still sent the stored `candidate.userPrompt` to the model as a live `role: "user"` message. That left the trust boundary incomplete even though the text was sanitized and labeled.

### Additional change

Updated `composeAfterthought` so that:

- the sanitized stored prompt is included only inside the `system` prompt
- the historical block remains explicitly labeled as untrusted historical context
- the live `user` message is now a neutral generation instruction with no stored log text
- the bounded `reply-outcomes.jsonl` read cap remains unchanged

### Regression update

Tightened `tests/afterthought.test.js` so it now asserts that:

- there is still exactly one `user` role message
- no `user` role message contains the stored historical text or its injection payload
- the sanitized historical text is present only in non-user prompt content
- raw `<system>` and raw injected closing tags are absent from that non-user content

### Exact test output

`node --test tests/afterthought.test.js`

```text
✔ tests/afterthought.test.js (342.228423ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 363.279218
```

`node --check lib/afterthought.js`

```text
```
