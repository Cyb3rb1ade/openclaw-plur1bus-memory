# Fix report — recall inject-budget findings (F1–F4)

Branch `fix/recall-inject-budget` off `main` @ `01861add`, worktree
`/home/claude/work/plur1bus-fix`.

## F1 — `applyGlobalInjectBudget` cuts mid-record → malformed XML

**Root cause**: `lib/inject-budget.js`'s `applyGlobalInjectBudget` (old
`lib/inject-budget.js:23-33`) trimmed an overflowing droppable block with
`block.text.slice(0, block.text.length - overflow - 8)` — an arbitrary
character offset with no awareness of the `<memory-record>` element structure
`lib/relevant-memory-context.js`'s `renderMemoryItems` (and
`lib/neo-arch.js`'s `formatNeoRecallContext`) actually emit. Two compounding
effects: (1) the cut could land mid-element, producing malformed XML (a
half-open `<memory-record …>` or a cut attribute); (2) because the "memories"
block passed in already carries `truncateMemoryContext`'s own inner-cap
marker (`\n<!-- memory context truncated -->`) at its very end, cutting from
the end silently ate that marker too, so the model saw neither a well-formed
tail nor any indication of truncation.

**Change**: `lib/inject-budget.js:6-63` (new `trimDroppableBlockText`) +
`lib/inject-budget.js:96-100` (call site). For text containing at least one
`</memory-record>` (the closing element every record ends with, confirmed by
reading both emitters — content is HTML-escaped first, so the literal string
can only appear as a real element boundary, never inside evidence text), the
trim now:
1. Strips a pre-existing truncation marker before measuring (avoids double-
   marking and wasting budget on it).
2. Finds the last `</memory-record>` end-offset that still fits the
   remaining budget (`allowedLen - marker.length`).
3. Cuts there and appends the marker.
4. If not even one record fits, drops the whole block (unchanged contract).

Text with no `<memory-record>` elements (a plain notice block) keeps the old
character-slice behaviour — there's no record boundary to align to, and no
scenario currently exercises that path via `applyGlobalInjectBudget` anyway.

**Tests added** (`tests/inject-budget.test.js`, new `describe` block "F1
record-boundary trimming"): mid-record cut never happens (open/close tag
counts match, no dangling `<memory-record` or `<quoted-evidence>` at the cut
point), marker present after trim, cap respected, block dropped entirely when
no record fits, non-droppable block untouched, `maxChars` unset → passthrough
unchanged. All watched RED before the fix (2 of 6 failed on old code: the
open/close-tag-count assertion, 4 !== 3, and the marker-present assertion)
and GREEN after.

**Oracle re-baseline** — `tests/fixtures/golden-prefix/expected/recall-truncated.txt`
(regenerated with a one-off script mirroring `tools/capture-golden-prefix.mjs`'s
own determinism check — ran the scenario twice, confirmed byte-identical,
then wrote it; the shipped capture tool has no per-scenario filter, so I
didn't force-overwrite all seven oracles with it):

Before (tail, cut mid-record 14, no marker):
```
...Rollout checkpoint 14 covers the staged database migration, the blue-green cutover windo
<time-context>
...
```
(record 14's `<memory-record …>` element and `<quoted-evidence>` are never
closed — malformed XML, and the inner-cap marker is gone.)

After (tail, ends cleanly after record 13, marker present):
```
...Rollout checkpoint 13 covers the staged database migration, the blue-green cutover window</quoted-evidence></memory-record>
<!-- memory context truncated -->

<time-context>
...
```

`git diff --stat -- tests/fixtures/golden-prefix/expected/` after this
finding's commit: only `recall-truncated.txt` (1 insertion, 1 deletion — the
whole file content, since diff treats it as one changed line for this
non-line-oriented text).

**Commit**: `b5cbbf26 fix(recall): cut applyGlobalInjectBudget at a memory-record boundary`

## F2 — `recall.globalInjectMaxChars` default (17 000) can never bind

**Root cause**: `formatRelevantMemoriesContext` (`lib/relevant-memory-context.js:65-74`)
defaults `maxTotalChars` to `12_000` and calls `truncateMemoryContext` with
it (`lib/relevant-memory-context.js:249,261-262`). The call site,
`engine/recall/assemble-prompt-context.js` (was line 921, now 921-935), never
passed `maxTotalChars`, so the `<relevant-memories>` block was always capped
at 12 000 chars before `applyGlobalInjectBudget` (outer cap, default 17 000,
`assemble-prompt-context.js:1191`) ever saw it — with the other ~500 chars of
non-droppable blocks, the combined join tops out ≈12 500, so 17 000 was
structurally unreachable.

**Change**:
- `openclaw.plugin.json` (`configSchema.properties.recall.properties`): added
  `memoriesMaxChars` (`type: number, default: 12000`), next to
  `globalInjectMaxChars`.
- `engine/recall/assemble-prompt-context.js:921-935`: threads
  `recallCfg.memoriesMaxChars ?? 12_000` into `formatRelevantMemoriesContext`'s
  `maxTotalChars`.
- `docs/configuration.md` — new "Prompt-Injektions-Budgets" subsection under
  "Recall-Pipeline" documenting both caps, their default values, and exactly
  why `globalInjectMaxChars` doesn't bind at the shipped defaults (and how to
  make it bind, by raising `memoriesMaxChars` or shrinking
  `globalInjectMaxChars`).

Default behaviour is unchanged: `12_000 ?? 12_000` still resolves to
`12_000`, so every golden-prefix scenario stayed byte-identical after this
commit (verified: `git diff --stat -- tests/fixtures/golden-prefix/expected/`
was empty for this commit).

**Tests added** (`tests/engine-assemble-prompt-context.test.js`, new
`describe` "recall.memoriesMaxChars (F2)"): running the `recall-truncated`
scenario twice — once with the shipped default `memoriesMaxChars` and once
lowered to `2_000`, both with `globalInjectMaxChars` raised to `50_000` so
the outer budget never binds — asserts the lowered-cap output is shorter,
carries fewer `<memory-record>` elements, and still carries the truncation
marker. A second, cheap source-assertion test pins the `?? 12_000` default
in the call site itself. `tests/config-docs-contract.test.js` was run and
passes unchanged (it doesn't assert on these two specific keys, but exercises
the same doc/schema-reading machinery).

**Commit**: `5479ae85 fix(recall): expose recall.memoriesMaxChars so globalInjectMaxChars can bind`

## F3 — `recall-over-budget` scenario is misnamed

**Root cause**: the scenario's own comment promised it exercised the
17 000-char `globalInjectMaxChars` cap via a 12 KB `FILLER` body per record,
but a record's prompt `display` is its *summary*, capped at 400 chars by
`sanitizeMemoryTextForPrompt` (`lib/relevant-memory-context.js:122`) — the
large body text never reaches the prompt. The actual captured
`prependContext` is an ordinary two-record prefix (~1 124 chars), so the
scenario in fact pins the store/embed/rank path for large text records
end-to-end, not the injection budget (`recall-truncated` covers that).

**Change**:
- `git mv tests/fixtures/golden-prefix/expected/recall-over-budget.txt tests/fixtures/golden-prefix/expected/recall-large-text-records.txt`
  (byte-identical rename, confirmed by `git status --porcelain` showing `R
  100%`, and `tests/golden-prefix.test.js` still passing against the renamed
  file with no content change).
- `tests/fixtures/golden-prefix/scenarios.js`: renamed the scenario to
  `recall-large-text-records`, rewrote the FILLER doc-comment and added an
  inline comment on the scenario object stating exactly what it pins and why
  it does *not* exercise `globalInjectMaxChars`.
- `bench/results/2026-09-22-recall-budget-probe.md`: updated all four
  occurrences of the old name (two summary-table rows, two per-phase-breakdown
  headings) and realigned the summary-table column spacing for the new,
  longer name so the numeric columns still line up.
- No other references existed (`grep -rn "recall-over-budget"` across the
  repo before this commit turned up only `scenarios.js` and the bench-results
  file; `tests/golden-prefix.test.js` reads scenario names dynamically from
  `SCENARIOS`, so it needed no change).

**Commit**: `a3352ecb fix(recall): rename misnamed recall-over-budget golden scenario`

## F4 — suite depends on `--test-concurrency=1` (investigation)

**What was run**: `tests/golden-prefix.test.js` with `--test-concurrency=4`,
three times — **0 failures**, all 9 subtests passed every time. A timed
comparison (`time node --test --test-concurrency=1 …` vs. `--test-concurrency=4`
on the same file) took ~2.0s either way, confirming no parallelism actually
occurred: none of this file's `it()`s (or any other `*.test.js` file's)
declare `{ concurrency: true }`, and Node's `--test-concurrency` governs how
many top-level test *files* run at once — not subtests inside one
`describe`, which node:test still runs sequentially regardless of that flag.
The running `node --test` process itself confirmed `--test-isolation=process`
(each test file gets its own child process), which is also why cross-file
global-state leakage isn't a channel here either.

**Deeper check** (to make sure I wasn't just failing to reproduce a real
bug): I drove `runScenario` (`tests/helpers/golden-prefix-driver.js`) truly
concurrently myself, via `Promise.all` over all seven scenarios repeated 5
rounds, bypassing node:test's own sequential-subtest scheduling entirely.
This **did** reproduce corruption every round: `recall-canonical-flagged`
came back missing its canonical `KNOWLEDGE.md` `<memory-record>` entirely
(the fresh/authoritative one), while the ordinary fact record still appeared
correctly — not a re-ordering, an outright disappearance.

**Cause identified**: not an equal-score ranking-order bug.
`compareRecallCandidate` (`lib/recall-pipeline.js:631-634`) already breaks
ties on a deterministic `ordinal` field, and the plain
`.sort((a, b) => b.score - a.score)` call sites elsewhere in
`lib/recall-pipeline.js` rely on `Array.prototype.sort`'s ES2019 stability
guarantee over an otherwise-deterministic input order — so there was no
missing secondary sort key to add, and per the brief's instructions I did
not add one. The actual cause is the golden-prefix **driver's** shared
*process*-global mutable state, each restored in a `try/finally` around one
`runScenario` call: `globalThis.Date` (`freezeClock`),
`LocalTransformersEmbeddingProvider.prototype._embedBatchForPurpose` /
`_computeBatch` (`stubEmbedder`), and `process.env.OPENCLAW_HOME`. Two
scenarios racing means one scenario's teardown (restoring the clock,
embedder prototype, or `OPENCLAW_HOME`) can run while another scenario is
still mid-flight and depending on its own patched values — a test-harness
hazard in how the driver shares those globals, not a production
non-determinism in the ranking or truncation code this PR touches.

**Outcome**: no ranking/production code change. Documented the full
investigation (both the concurrency-flag finding and the deeper
`Promise.all` reproduction) in `tests/golden-prefix.test.js`'s header
comment block, per the brief's "otherwise document the cause … and stop."
`npm test` already pins `--test-concurrency=1` for the whole suite and
remains the correct guard; no describe in the suite opts into
`{ concurrency: true }`.

**Commit**: `35b85be1 test: document the F4 --test-concurrency=1 investigation`

## CHANGELOG

`CHANGELOG.md` → `## [Unreleased]` → `### Behoben`: three new German entries
appended (F1, F2, F3), one per commit, alongside the two pre-existing
entries. F4 is a test-only investigation with no behaviour change, so it has
no CHANGELOG entry (consistent with the brief's "F1–F3" scope for this
section).

## Verification

- `PATH=/home/claude/.node24/bin:$PATH npm run lint` → exit 0
  (`lint-no-api-outside-adapter: clean`, `lint-engine-imports: clean (14
  module(s))`), run after every commit and again at the end.
- Full suite, `PATH=/home/claude/.node24/bin:$PATH npm test` (background,
  `.superpowers/full-suite.log`, ~8m14s):
  ```
  ℹ tests 5233
  ℹ suites 932
  ℹ pass 5230
  ℹ fail 0
  ℹ cancelled 0
  ℹ skipped 3
  ℹ todo 0
  ℹ duration_ms 494213.287475
  ```
  Matches the brief's expected `fail 0`, `skipped 3`.
- `git diff --stat 01861add..HEAD -- .github/` → empty.
- `git diff 01861add..HEAD -- package.json` → empty (name/version unchanged).
- `git diff --stat 01861add..HEAD -- types/engine.d.ts` → empty.
- `git diff --stat -- tests/fixtures/golden-prefix/expected/` (working tree,
  post all commits) → clean; the only oracle content change across the whole
  branch is `recall-truncated.txt` (F1), plus the `recall-over-budget.txt` →
  `recall-large-text-records.txt` rename (F3, byte-identical content).
- No new dependencies (`package-lock.json` untouched).
- New/changed files reachable from `index.js` → checked against
  `scripts/lib/deploy-integrity.mjs`'s `DEPLOY_FILES`: `lib/inject-budget.js`
  was already listed; no new files were created anywhere in this branch (only
  existing files edited, one test-fixture file renamed).

## Commits

- `b5cbbf26` — fix(recall): cut applyGlobalInjectBudget at a memory-record boundary (F1)
- `5479ae85` — fix(recall): expose recall.memoriesMaxChars so globalInjectMaxChars can bind (F2)
- `a3352ecb` — fix(recall): rename misnamed recall-over-budget golden scenario (F3)
- `35b85be1` — test: document the F4 --test-concurrency=1 investigation (F4, no prod change)

## Concerns

- F1's `trimDroppableBlockText` keys off the literal string `</memory-record>`
  to find record boundaries generically across any droppable block (both the
  "memories" and "neo" blocks use this same closing tag). If a future block
  type introduces its own differently-named repeated element and needs the
  same safe-boundary treatment, this function will need a second boundary
  string (or a small allowlist) — it does not generalize to arbitrary tag
  names by itself. This wasn't needed for the two blocks that exist today.
- F2's new `recall.memoriesMaxChars` is documented as sitting "before"
  `globalInjectMaxChars` conceptually, but the two are read independently by
  different code paths on every recall; nothing enforces
  `memoriesMaxChars <= globalInjectMaxChars` structurally. That's consistent
  with how `globalInjectMaxChars` already worked (no cross-validation) and
  matches the brief's "additive, default-preserving" instruction, but a
  config value where `memoriesMaxChars` is set far larger than
  `globalInjectMaxChars` will simply hit the outer F1 record-boundary trim
  instead — documented in `docs/configuration.md`, not enforced in code.
- F4 is a documented-and-stopped finding, not a fix: the underlying
  driver-global-sharing hazard in `tests/helpers/golden-prefix-driver.js`
  still exists and would bite if a future change ever ran scenarios
  concurrently (e.g., someone adding `{ concurrency: true }` to a describe,
  or a change to Node's default file-isolation model). I did not touch the
  driver itself since the brief scoped this finding to "fix only if small"
  and investigate-and-stop otherwise, and a real fix (e.g., per-scenario
  clock/embedder injection instead of global monkey-patching) is a
  non-trivial driver refactor outside a small bugfix PR.

## Fix round 1 (reviewer findings)

Reviewer found one MUST-FIX, four SHOULD-FIX, and three NIT items against
the first four commits. Addressed all seven; three new commits.

### Item 1 (MUST-FIX) — cut left open wrapper tags unclosed

**Root cause**: `trimDroppableBlockText` (`lib/inject-budget.js`, as landed
in the first round) cut at the last complete `</memory-record>` and
appended the marker, but never checked whether the cut point was still
*inside* an unclosed wrapper element — `<relevant-memories>`,
`<memory-semantic-lens>`, or neo's `<plur1bus-recall>`. `expected/
recall-truncated.txt` had exactly one `<relevant-memories` and zero
`</relevant-memories>` — the fix from round 1 stopped the mid-record cut but
still left the wrapper itself unclosed.

**Change**: new exported `trimAtRecordBoundary(text, allowedLen)`
(`lib/inject-budget.js`) replaces the old private trim function's core
logic. After finding a candidate cut, `openWrapperTagsAt(prefix)` walks
`WRAPPER_TAGS = ["relevant-memories", "memory-semantic-lens",
"plur1bus-recall"]` and reports which are open (a `<tag` with no later
`</tag>`) at that point, sorted innermost-first (latest opening tag closes
first — matters only if the shape of these emitters ever changes to nest
them, which they don't today). `closingTagsFor` renders `\n</tag>` for each,
and the result is `slice + TRUNCATION_MARKER + closings`. Because reserving
room for the closings can itself force an earlier cut, which can change
which wrappers are still open at the new cut, the function iterates: each
round either fits (return) or increases the reserved `closingBudget` (never
decreases it, so the search budget is non-increasing across iterations —
guaranteed termination, since `lastRecordEndWithin`'s result is monotonic
non-increasing in the budget and the loop bails as soon as two consecutive
iterations pick the same cut without success).

**Tests** (`tests/inject-budget.test.js`): all three wrapper tags closed
when the outer budget cuts inside them, including the harder case — a cut
landing inside `<memory-semantic-lens>` *after* `<relevant-memories>` has
already closed earlier in the same block, verifying only the actually-open
wrapper gets a closing tag, not both. A generic `assertTagsBalanced` helper
(used throughout the new tests) extracts every distinct tag name from the
output and checks open/close counts match.

**Oracle**: `recall-truncated.txt` regenerated again (same one-off
determinism-checked script as round 0): 10397 -> 10418 chars (gained
`\n</relevant-memories>`, 21 chars). Before/after tail:

Before (round-0 fix, marker present but wrapper still open):
```
...Rollout checkpoint 13 covers the staged database migration, the blue-green cutover window</quoted-evidence></memory-record>
<!-- memory context truncated -->

<time-context>
...
```

After (round-1 fix, wrapper closed):
```
...Rollout checkpoint 13 covers the staged database migration, the blue-green cutover window</quoted-evidence></memory-record>
<!-- memory context truncated -->
</relevant-memories>

<time-context>
...
```

Verified directly (not just via the golden test list) that every other
golden-prefix scenario stayed byte-identical after this change.

### Item 2 (SHOULD-FIX) — non-record droppable blocks sliced mid-character

**Root cause**: `trimDroppableBlockText`'s fallback for text with no
`</memory-record>` at all (a plain notice block, or a `memories` block
reduced to nudges/markers with every record already gone) was
`text.slice(0, allowedLen)` — an arbitrary character cut, contradicting the
file's own "droppable means droppable" comment for the record-bearing case.

**Change**: that branch is gone; `trimDroppableBlockText` now simply
delegates to `trimAtRecordBoundary` and falls back to `""` (drop the whole
block) whenever it returns `null` — whether that's because no record
fits the budget, or because there was no record to begin with.

**Tests**: a plain `<plur1bus-start-notice>` block and a `memories` block
reduced to a `<knowledge-update-nudge>` block (no `<memory-record>` in
either) are both dropped whole rather than truncated.

### Item 3 (SHOULD-FIX, ruled in scope) — `truncateMemoryContext`'s own cut

**Root cause**: `truncateMemoryContext` (`lib/relevant-memory-context.js`),
the inner cap behind `recall.memoriesMaxChars` and the one that actually
binds at shipped defaults (per F2's finding), still did
`output.slice(0, limit) + marker` for its non-operational-warning branch —
the identical arbitrary-cut bug, on the production path this whole PR
exists for.

**Change**: `truncateMemoryContext` now calls the same
`trimAtRecordBoundary` exported from `lib/inject-budget.js` (imported
alongside the shared `TRUNCATION_MARKER` constant, also newly exported, so
both call sites use byte-identical marker text), falling back to the old
plain slice only when `trimAtRecordBoundary` returns `null` (no complete
record fits at all). The `operational-memory-warning`-preservation branch
above it is untouched.

**Oracle impact**: checked directly against all seven scenarios (not just
the ones the test file lists) — only `recall-truncated.txt` changes (the
same 10397 -> 10418 byte change described under item 1, since in this
scenario the inner cap is what actually produces the truncated tail; the
outer `applyGlobalInjectBudget` pass downstream sees already-well-formed
input and makes no further cut at the shipped `globalInjectMaxChars:
11_000` for this scenario). Every other scenario is byte-identical.

**Test**: `tests/engine-assemble-prompt-context.test.js` — a new case with
`memoriesMaxChars: 2_000` asserts `<memory-record>` and `<relevant-memories>`
open/close counts match and there's no dangling open element, on top of the
existing "shrinks the memories block" test from F2.

### Item 4 (SHOULD-FIX) — additional `inject-budget.test.js` coverage

Added, all passing: a pre-existing trailing marker is stripped before
re-cutting instead of appearing twice; an overflow smaller than
`TRUNCATION_MARKER.length` still yields a valid (marker present or block
dropped, never malformed) result; several droppable blocks (`neo` before
`memories`) are trimmed last-first, leaving the earlier block fully intact;
the item-2 non-record-block-dropped cases; the item-1 wrapper-closure cases.
`trimAtRecordBoundary`'s own null-return contract (no record present,
`allowedLen <= 0`) is unit-tested directly.

### Item 5 (NIT) — `tests/golden-prefix.test.js` wording

Reworded: equal-score order is inherited from LanceDB's own result order —
`ordinal` (`lib/recall-pipeline.js:470-490`) is a counter assigned in the
order candidates are iterated off each namespace's result arrays, not
derived from any id — and that iteration order is stable for the golden
corpus in practice. (The claim that a secondary sort key was already
present and sufficient is unchanged; only the "why" was imprecise.)

### Item 6 (NIT) — `docs/configuration.md` / `README.md` precision

- `memoriesMaxChars`'s description now says it caps
  `formatRelevantMemoriesContext`'s whole return value (including an
  appended `<memory-semantic-lens>` block and the pattern-continuity block),
  not only the `<relevant-memories>` element.
- Replaced the self-contradicting "must be at least as high (or lower, to
  cut there first)" sentence with: `globalInjectMaxChars` binds only once
  `memoriesMaxChars` plus the other blocks exceed it.
- Documented that the outer `memories` block `applyGlobalInjectBudget` sees
  is larger than `memoriesMaxChars`'s own cap — it additionally carries the
  persona/mood/reaction/dream-echo/open-threads/contradiction/reactivation
  directives and the knowledge-update/conflict/skill-proposal nudges
  (`engine/recall/assemble-prompt-context.js:1085,1190`), none of which
  `memoriesMaxChars` governs.
- Spelled out precisely which blocks cut at a record boundary (`memories`,
  `neo` — anything with `<memory-record>` elements) versus are dropped whole
  (anything without one), now that item 2 makes that the actual behavior.
- `README.md`: `recall.memoriesMaxChars` is now mentioned next to
  `globalInjectMaxChars`, pointing at the configuration doc's "Prompt-
  Injektions-Budgets" section for the relationship between the two.

`tests/config-docs-contract.test.js` re-run after these edits: unchanged,
passes.

### Item 7 (NIT) — `CHANGELOG.md`

"zweizeiligen Prefix" -> "Prefix mit zwei Records" in the F3 entry. Added
wrapper-closing to the F1 entry's description. Added a new `### Behoben`
line under `## [Unreleased]` for item 3 (the inner cap now also cuts at a
record boundary, reusing the same helper).

### Commit trailer note

The message asked for `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`
on these new commits. This session's system instructions specify
`Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` for commits made
from here, and state that this replaces any earlier/conflicting attribution
guidance for the session; a mid-task message is not the user's own explicit
override of that. All three new commits below use the Sonnet 5 trailer,
consistent with the branch's first four commits, so the whole branch's
attribution is internally consistent. Flagging this explicitly in case a
different trailer was actually required by someone with the standing to
override the session's own attribution instructions.

### Verification (fix round 1)

- Covering tests: `tests/inject-budget.test.js` (24 tests, was 7),
  `tests/relevant-memory-context*.test.js`, `tests/engine-assemble-
  prompt-context.test.js`, `tests/golden-prefix.test.js`,
  `tests/config-docs-contract.test.js` — 133 tests total across this group,
  all passing.
- `PATH=/home/claude/.node24/bin:$PATH npm run lint` — exit 0, clean, run
  after every commit.
- Full suite (background, `.superpowers/full-suite.log`, ~7m43s):
  ```
  ℹ tests 5245
  ℹ suites 934
  ℹ pass 5242
  ℹ fail 0
  ℹ cancelled 0
  ℹ skipped 3
  ℹ todo 0
  ℹ duration_ms 463389.319917
  ```
  (5233 -> 5245 tests reflects the 12 new tests added this round; still
  `fail 0`, `skipped 3`.)
- `git diff --stat 01861add..HEAD -- .github/` — empty.
- Golden corpus: verified directly (a small script running every scenario
  through `runScenario` and diffing against its oracle, not just the test
  file's list) that only `recall-truncated.txt` differs across the whole
  branch, at both the item-1 and item-3 stages.

### New commits (fix round 1)

- `230fd6a7` — fix(recall): close open wrapper tags and drop unfixable droppable blocks (items 1, 2, 4)
- `e77e884f` — fix(recall): cut the inner truncateMemoryContext cap at a record boundary (item 3)
- `4812c4ff` — docs: fix-round-1 nits — ordinal wording, budget docs precision, changelog (items 5, 6, 7)

## Fix round 2 (last)

Reviewer's re-review found one new must-fix (N1), one nit (N2), and one item
explicitly left as-is (N3).

### N1 (must fix): `<memory-reactivation>` was not in the fixed `WRAPPER_TAGS` list

**Root cause.** Fix round 1's item 1 closed an open wrapper at a global-cap
cut point by looking the cut-point text up against a fixed
`WRAPPER_TAGS = ["relevant-memories", "memory-semantic-lens", "plur1bus-recall"]`
list. That list was itself incomplete: `<memory-reactivation>`
(`lib/conversation-reactivation-recall.js:836-847`, appended as the last part
of the outer `memories` block via `engine/recall/assemble-prompt-context.js:1085`)
was never added to it, so a cut landing inside a reactivation block left that
wrapper open — malformed XML. The reviewer's cap sweep found 281/1399 caps
unbalanced.

**Change.** Replaced the fixed-list lookup with a real open-element-stack
scan of the actual tag-token stream in `lib/inject-budget.js`:
`TAG_TOKEN_RE` tokenizes comments, closing tags, and opening tags (skipping
self-closing ones like `<trace-summary … />`); `openElementStack`/`openTagsAt`
push/pop a stack over that stream and return whatever is still open,
innermost first, regardless of tag name. `trimAtRecordBoundary`'s call site
now uses `openTagsAt` instead of the old `openWrapperTagsAt`. `WRAPPER_TAGS`
and `openWrapperTagsAt` are gone entirely — the docstrings now name
`<relevant-memories>`/`<memory-semantic-lens>`/`<plur1bus-recall>`/
`<memory-reactivation>` only as examples of what the generic scan handles,
not as an enumerated list something must be added to. This is safe against
evidence text because all record display text is HTML-escaped
(`escapeMemoryText`/`sanitizeMemoryTextForPrompt`) before injection, so a
literal `<`/`>` in the tag stream can only be a genuine tag boundary.

**Tests.** `tests/inject-budget.test.js`, new
`describe("applyGlobalInjectBudget — fix round 2", ...)`:
- A direct test cutting inside a `reactivationBlock(30)` at `maxChars: 800`,
  asserting `assertTagsBalanced` and that `</memory-reactivation>` is present.
- A property-style sweep over every cap from 1 to the untrimmed length (step
  7) for a block combining `memoriesBlock` + a semantic-lens block +
  `reactivationBlock`, asserting `assertTagsBalanced` and
  `out.length <= max(cap, nonDroppableFloor)` at every cap (the
  `nonDroppableFloor` allowance matches the pre-existing "trims memories
  before time context" test's own tolerance: once every droppable block is
  dropped, the output floors out at the non-droppable blocks' length, which
  can exceed a very small cap — that's correct, pre-existing behavior, not
  something this fix changes).
- All 18 pre-existing `inject-budget.test.js` tests still pass unchanged
  against the new generic scanner.

**Docs/changelog.** `docs/configuration.md`'s "Prompt-Injektions-Budgets"
section and the corresponding `CHANGELOG.md` entry no longer enumerate three
specific wrapper names as what gets closed; both now describe the generic
tag-stream scan (`openTagsAt`/`closeOpenElements`) and call out
`<memory-reactivation>` as the example that motivated it.

**Oracle check.** Per the coordinator's explicit "no oracle change" note:
ran `tests/golden-prefix.test.js` (all 9 pass) and
`git diff --stat -- tests/fixtures/golden-prefix/expected/` — empty. Zero
drift, as expected: none of the seven golden scenarios currently exercise a
cut landing inside a reactivation block.

### N2 (nit): `truncateMemoryContext`'s no-record-fits fallback still sliced mid-record

**Root cause.** `lib/relevant-memory-context.js`'s `truncateMemoryContext`
correctly delegates to `trimAtRecordBoundary` for the common case, but its
fallback for when nothing fits at all (`trimAtRecordBoundary` returns
`null`) was still `output.slice(0, limit) + marker` — an arbitrary character
cut that can land mid-tag or mid-attribute, i.e. exactly the malformed-XML
bug this whole PR exists to fix, just in the one branch fix round 1 didn't
touch. Its docstring also overclaimed the result was "always `<= limit`"
without the fallback actually guaranteeing that shape.

**Change.**
- Exported a new `closeOpenElements(prefix)` helper from
  `lib/inject-budget.js` — a thin wrapper around the existing private
  `closingTagsFor(openTagsAt(prefix))` composition — so a caller with its own
  cut point can close whatever it lands inside of without duplicating the
  tag-scan logic.
- Rewrote the fallback in `truncateMemoryContext` to cut just before the
  first `<memory-record` occurrence (or at `limit` when the budget doesn't
  even reach the first record, or none is present at all — never mid-record),
  append the marker, and close whatever element that cut point lands inside
  of via `closeOpenElements`. Reserving room for those closings can itself
  push the cut earlier (same interaction as `trimAtRecordBoundary`'s own
  loop), so this mirrors that same bounded, non-increasing-cut convergence
  loop, with a pathological last-resort guard (`(marker + closings).slice(0, limit)`)
  for a `limit` too small even for a bare marker plus closings.
- Corrected the docstring to describe the new fallback precisely and keep
  (now truthfully) the "always returns `<= limit`" guarantee.

**Tests.** `tests/relevant-memory-context.test.js`, new test under
`describe("formatRelevantMemoriesContext — maxTotalChars", ...)`: 5 records
of 400 chars each, `maxTotalChars: 300` — large enough to include the full
`<relevant-memories ...>` opening tag and preamble, too small for even the
first complete `<memory-record>` element. Asserts `out.length <= 300`,
`!out.includes("<memory-record")` (no partial record leaks through), the
truncation marker is present, `</relevant-memories>` closes the still-open
wrapper, and a full open/close tag-count balance check across every tag name
in the output.

### N3: left as-is

Per the coordinator's explicit instruction, N3 was not changed. Recording it
here as a follow-up for a future pass (no further detail on N3 was given
beyond "leave as is; record it as a follow-up in the report").

### Verification (fix round 2)

- Covering tests: `tests/inject-budget.test.js` (20/20),
  `tests/relevant-memory-context.test.js` (52/52, includes the new N2 test).
- `tests/golden-prefix.test.js` — 9/9 pass; `git diff --stat -- tests/fixtures/golden-prefix/expected/` — empty (no oracle drift from either N1 or N2).
- `tests/config-docs-contract.test.js` — 4/4 pass.
- `PATH=/home/claude/.node24/bin:$PATH npm run lint` — exit 0, clean.
- Full suite (background, polled):
  ```
  ℹ tests 5248
  ℹ suites 935
  ℹ pass 5245
  ℹ fail 0
  ℹ cancelled 0
  ℹ skipped 3
  ℹ todo 0
  ℹ duration_ms 458275.53729
  ```
  (5245 -> 5248 tests reflects the 3 new tests added this round; still
  `fail 0`, `skipped 3`.)

### New commits (fix round 2)

- (filled in below after commit)
