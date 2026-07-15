# Task 3 Audit Fixes — Implementation Report

## What I implemented

- Removed the auto-recall early return in [index.js](/root/openclaw-plur1bus-memory/index.js) so prompt assembly continues even when both `ordered` and `canonicalHits` are empty.
- Preserved empty-recall behavior by letting `items`, `associativeItems`, and `formatRelevantMemoriesContext(...)` operate on empty arrays.
- Kept additive prompt context assembly intact for no-memory recalls, including `neoContext` and `startNoticeContext`.
- Prevented semantic-lens fallback from becoming a second recall path on empty base recall by using an empty semantic-lens result when both primary and canonical recall are empty.
- Tightened open-thread cooldown writes so `.open-threads-shown.json` is only written when `openThreadsContext` exists and at least one normalized topic was derived.
- Changed `shouldShowNudge(...)` ordering so the day cap still runs first, but quiet hours now block before the `lastShown == null` first-nudge allowance.
- Wired same-day proactive day-cap enforcement into `runProactiveCheck(...)` by:
  - counting existing nudges already generated on the same UTC date
  - passing `shownToday` into `shouldShowNudge(...)`
  - incrementing `shownToday` during the loop so one run cannot exceed the cap

## What I tested and exact test result

Focused command from the brief:

```bash
node --test tests/proactive-nudge-timing.test.js tests/proactive-check.test.js
```

Exact result:

```text
✔ tests/proactive-check.test.js (318.547956ms)
✔ tests/proactive-nudge-timing.test.js (190.625824ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 340.9889
```

## TDD evidence

RED:

```bash
node --test tests/proactive-nudge-timing.test.js tests/proactive-check.test.js
```

Observed failures:

```text
✖ tests/proactive-check.test.js
✖ tests/proactive-nudge-timing.test.js
```

Detailed red assertions used during diagnosis:

```bash
node tests/proactive-nudge-timing.test.js
node tests/proactive-check.test.js
```

Key failures:

```text
Ruhezeit blockt auch den ersten Nudge bei Stunde 23
true !== false

generates at most two nudges when three patterns are eligible on the same day
3 !== 2

counts existing same-day nudges toward the day cap
3 !== 1
```

GREEN:

```bash
node --test tests/proactive-nudge-timing.test.js tests/proactive-check.test.js
```

Pass output:

```text
✔ tests/proactive-check.test.js (318.547956ms)
✔ tests/proactive-nudge-timing.test.js (190.625824ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
```

## Files changed

- `index.js`
- `lib/proactive-nudge.js`
- `lib/jobs/proactive-check.js`
- `tests/proactive-nudge-timing.test.js`
- `tests/proactive-check.test.js`
- `.superpowers/sdd/task-audit-3-report.md`

## Self-review findings

- Scoped diff matches the Task 3 brief only.
- Pre-existing dirty files `lib/jobs/memory-dynamics-maintenance.js` and `tests/memory-dynamics-maintenance.test.js` were not edited.
- Day-cap counting is based on `generatedAt` UTC date strings already stored in `proactive-nudges.json`, which matches the brief.
- Open-thread cooldown writes are now gated on both rendered context and normalized topics, so empty outcomes no longer consume the daily stamp.

## Issues/concerns

- No additional automated coverage was added for the no-recall prompt assembly path in `index.js`; verification there is by scoped code inspection plus preservation of existing assembly flow.
