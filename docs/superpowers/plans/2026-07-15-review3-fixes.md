# Review-3 Fixes: Repair the audit-wave regressions + confirmed bugs

**Base:** a666752 · **Branch:** feature/humanization · **Findings source:** /code-review medium #3 (8 CONFIRMED findings over commits bcdcb19..a666752)

## Global Constraints

- **NEVER stage, commit, or modify** `lib/jobs/memory-dynamics-maintenance.js` or `tests/memory-dynamics-maintenance.test.js` (foreign WIP).
- TDD: each fix gets a failing test first (prove it fails on current code), then the fix, then green.
- Run the covering test files per task; the full suite runs once at the end.
- No `Co-Authored-By`/Claude attribution in commits.
- All behavior must stay generic for third-party installs (no server-specific paths).
- User requirement being restored (Task 1): multi-agent setups must work automatically without manual follow-up; per workspace only the main agent gets feature crons.

## Task 1 — Restore multi-agent delivery derivation + IS_MAIN symlink fix + marker gating

**Files:** `lib/setup/feature-cron-plan.js`, `scripts/setup-feature-crons.mjs`, `index.js` (runDeferredFeatureCronBootstrap), `tests/feature-cron-plan.test.js`, `tests/feature-cron-bootstrap.test.js`

1. **Restore delivery derivation** (reverts the `bcdcb19` hunk in `planSpecForAgents`): for `spec.needsDelivery`, call `delivery = deriveAgentDelivery(agentId, jobs)`; only when no target is derivable → `enabled = false` + hint. Set `account: delivery?.accountId ?? null`. Restore the doc comments ("deriving delivery for afterthought from that agent's other crons" / "when no delivery target can be derived"). `deriveAgentDelivery` still exists at line 151 and is tested — only the call was removed.
2. **buildAgentHint:** add `--account <account>` to the suggested `openclaw cron edit` command (wrong-bot delivery class, cf. osu-erik incident: `--agent` alone doesn't pick the right bot).
3. **IS_MAIN:** in `scripts/setup-feature-crons.mjs`, compare realpaths:
   ```js
   import { realpathSync } from "node:fs";
   const IS_MAIN = (() => {
     try { return process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
     catch { return false; }
   })();
   ```
   Empirically proven: plain `argv[1] === fileURLToPath(import.meta.url)` is false through symlinked dirs AND symlinked files (pnpm, npm link, symlinked extensions dir) — postinstall/bootstrap/`/plur1bus setup crons` all become silent no-ops. Add a test that spawns the script through a symlink (`--dry-run --json`, mkdtemp + symlink dir) and asserts non-empty stdout JSON.
4. **Marker gating** in `index.js` `runDeferredFeatureCronBootstrap`: write the marker ONLY when the spawn succeeded (`ok === true` from `close` with code 0). On failure, leave any existing marker untouched (log only) so `shouldRunCronBootstrap` retries at the next gateway start instead of throttling 20h while the hint nags. Keep parse-fallback `lastPlanCreateCount=1` for ok-but-unparseable output. Test in `tests/feature-cron-bootstrap.test.js`: failed run must not overwrite a previous `lastPlanCreateCount: 0` marker.

## Task 2 — Tail-read for oversized reply-outcomes.jsonl

**Files:** `lib/jsonl-utils.js`, `lib/reply-outcome-tracking.js`, `lib/afterthought.js`, `index.js` (2 call sites ~6047/~6091), `tests/reply-outcome-tracking.test.js`, `tests/afterthought.test.js`

Finding: `maxBytes` uses skip-ENTIRE-file semantics (readJsonl returns `[]` when size > cap) while rotation is entry-based (5000 entries, unbounded userPrompt + 2×4000-char fields → active logs exceed 2MB permanently) → afterthought/open-threads/governor adjustments silently die.

1. Add `readJsonlTail(path, { maxBytes })` to `lib/jsonl-utils.js`: when file ≤ maxBytes delegate to readJsonl; otherwise `open`+`read` the LAST maxBytes, drop everything before the first `\n`, parse remaining lines (skip broken). Newest entries live at the end (append-only log), so the tail is the right window.
2. Switch `readReplyOutcomeLog`'s maxBytes handling to `readJsonlTail` (keep the option name; semantics become "bounded read" instead of "skip"). Keep `onSkip` → call it as an info hook when truncating.
3. Existing 2MB caps at the three call sites stay as-is.
4. Tests: oversized file (>2MB) → newest entries are returned (not `[]`); afterthought test "liest reply-outcomes.jsonl im Cron-Pfad nur innerhalb des Size-Caps" must be UPDATED: an oversized log with a fresh open candidate in the tail now yields the candidate (this documents the intended new semantics — the old test asserted the bug).

## Task 3 — Persona seed off the hot path + ZWJ-safe emoji pattern

**Files:** `index.js` (~6010), `lib/persona-voice.js`, `tests/persona-voice.test.js`

1. **Seed off hot path:** replace `await ensurePersonaVoiceSeed(...)` in the before_prompt_build handler with fire-and-forget + in-process throttle:
   - module-level `personaSeedAttempts = new Map()` (workspaceDir → lastAttemptMs), retry no earlier than 6h after a failed attempt, and an in-flight guard so concurrent messages don't double-fire;
   - call without `await`, `.catch(() => {})`, so prompt assembly never blocks on an LLM call (finding: 30s default LLM timeout inside the 8s recallTimeoutMs window kills recall for every message when the seed keeps failing).
   - The directive load (`loadPersonaDirective`) stays synchronous in the hot path — file-read only.
2. **EMOJI_PATTERN:** match full ZWJ sequences + skin-tone modifiers as ONE unit:
   ```js
   const EMOJI_PATTERN = /\p{Extended_Pictographic}\p{Emoji_Modifier}*(?:️)?(?:‍\p{Extended_Pictographic}\p{Emoji_Modifier}*(?:️)?)*/gu;
   ```
   Tests: `'🏳️‍🌈'` → 1 match (not split into 🏳️+🌈); `'👨‍👩‍👧'` → 1 match; a single composite emoji must NOT pass the ≥2-emoji palette heuristic; `'🚀 ✨'` still → 2.

## Task 4 — Nudge quiet-hours order revert + TZ-safe test + entity-safe truncation

**Files:** `lib/proactive-nudge.js`, `tests/proactive-check.test.js`, `lib/contradiction-disclosure.js`, `tests/contradiction-disclosure.test.js`

1. **Revert the reorder** in `shouldShowNudge`: `if (lastShown == null) return true;` moves back BEFORE the quiet-hours block (original semantics: first nudge always allowed — a proactive-check job scheduled only at night otherwise never produces anything, silently). Quiet hours continue to gate repeat nudges.
2. **TZ-determinism:** `tests/proactive-check.test.js` currently fails under `TZ=America/Los_Angeles` (empirically reproduced). After the revert, verify with `TZ=UTC` and `TZ=America/Los_Angeles`; where a case still depends on local hour, pass explicit `quietHours: false` or choose a `now` that is outside quiet hours in all TZs by construction (document why).
3. **Entity-safe truncation** in `lib/contradiction-disclosure.js`: `truncate()` slices ALREADY-ESCAPED text (`sanitizeMemoryTextForPrompt` truncates before escaping, so output may exceed `max` and the slice cuts `&amp;` mid-entity → dangling `&am`). Fix both levels (item truncate ~line 35 AND block-level cap ~line 46): after slicing escaped text, strip a trailing incomplete entity with `.replace(/&[a-zA-Z]{0,5}$/, "")` before appending `…`. Test: input whose escaped form exceeds max must not end in a partial entity; block-level cap likewise.

## Final

- Full suite `npm test` (expect green except the 1 pre-existing skip).
- Single whole-wave review over a666752..HEAD.
- Push.
