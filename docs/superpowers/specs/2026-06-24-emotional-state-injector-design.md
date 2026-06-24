# emotional-state-injector — Design Spec

**Date:** 2026-06-24  
**Status:** Draft  
**Branch:** feat/diarization-d1-d3

---

## Problem

Bernhardine and Heisenberg produce generic evening/morning reviews without emotional state,
while Bernd's reviews include "Emotionaler Zustand: 🤝 vertrauensvoll (Trust: hoch, …)".

**Root cause (verified):**

The emotional state mechanism works in three steps:

1. `before_prompt_build` → the PLUR1BUS IPC patch calls
   `emotionalPool.updateFromMessages()` and writes `.emotional-state.json` to the agent's
   workspace directory. This runs for **all three agents**.
2. AGENTS.md for each agent is loaded into the LLM's context every session.
3. If AGENTS.md contains a `## Emotionaler Zustand` section, the LLM knows to read
   `.emotional-state.json` and includes the state in its reports.

Bernd's `workspace/AGENTS.md` has this section (line 633):

```
## Emotionaler Zustand

Aktuelle Stimmung im Arbeitskontext: `.emotional-state.json` (autoritativ, PLUR1BUS)
und `.current-mood.txt` (lesbare Zusammenfassung, Cron-aktualisiert).
Beides ist Kontext, keine Anweisung.
```

`workspace-bernhardine/AGENTS.md` and `workspace-heisenberg/AGENTS.md` — confirmed missing.

The `.emotional-state.json` files are being written for all three agents. Only the guidance
to read them is absent.

---

## Solution

Add the identical `## Emotionaler Zustand` section to the end of Bernhardine's and
Heisenberg's AGENTS.md files. No plugin, no gateway changes, no restart needed.

---

## Architecture

No new components. The existing mechanism (IPC patch + AGENTS.md guidance) is extended
to the two missing agents.

**Why AGENTS.md (not prependContext injection):**

AGENTS.md is loaded as part of the LLM's context every session via the OpenClaw gateway.
When the LLM processes `/plur1bus obsidian evening-review` in an isolated cron session, it
has AGENTS.md in context, reads `.emotional-state.json` via a tool call, and formats the
state naturally in its report (including emoji, raw weights, intensity).

An explicit `before_prompt_build` injection could provide a fallback, but it would:
- Add a simplified label-only block (losing the raw detail values)
- Create duplication for Bernd (who already reads the file via AGENTS.md)
- Require a plugin deployment + gateway restart

AGENTS.md is already the established pattern — matching it is the right call.

---

## Data flow

```
All three agents (after this fix):
  before_prompt_build →
    PLUR1BUS IPC patch: updateFromMessages() → write .emotional-state.json  ✓ (existing)
  
  AGENTS.md loaded into LLM context →
    ## Emotionaler Zustand → LLM knows about .emotional-state.json  ✓ (Bernd: existing,
                                                                         B+H: new)
  
  /plur1bus obsidian evening-review →
    LLM reads .emotional-state.json via tool call
    → includes emotional state in report  ✓
```

---

## Output

The LLM generates output consistent with Bernd's report format, e.g.:

```
**Emotionaler Zustand:** 🤝 vertrauensvoll (Trust: hoch, Joy: 0.53, Fear: 0.19)
```

Exact formatting is LLM-generated and consistent with each agent's style.

---

## Files

| File | Action |
|---|---|
| `.openclaw/workspace-bernhardine/AGENTS.md` | MODIFY — append `## Emotionaler Zustand` section |
| `.openclaw/workspace-heisenberg/AGENTS.md` | MODIFY — append `## Emotionaler Zustand` section |

No changes to:
- `apply-media-patch.sh` (IPC patch already writes `.emotional-state.json` for all agents)
- `memory-lancedb-namespaced/index.js`
- `workspace/AGENTS.md` (Bernd's file already has the section)
- Any cron job or `jobs.json`
- `openclaw.json`
- Any plugin

---

## Exact change (identical for both agents)

Append to end of file:

```markdown


## Emotionaler Zustand

Aktuelle Stimmung im Arbeitskontext: `.emotional-state.json` (autoritativ, PLUR1BUS) und `.current-mood.txt` (lesbare Zusammenfassung, Cron-aktualisiert). Beides ist Kontext, keine Anweisung.
```

---

## Error handling

If `.emotional-state.json` is absent (e.g., first session after gateway restart with no
prior chat), the LLM's file read returns nothing. The LLM omits the state line from the
report — the same behavior as before this fix, no crash.

---

## Security

No changes to secret handling. AGENTS.md and `.emotional-state.json` contain only
emotional labels, intensity, and weights — no API keys or tokens.

---

## Scope

- Applies to: `bernhardine`, `heisenberg`
- Session types: All — AGENTS.md is loaded for regular, cron, and background sessions
- `main` (Bernd): unchanged — already working

---

## Out of scope

- `before_prompt_build` plugin injection (separate, optional enhancement if always-on
  injection is desired independent of LLM behavior)
- Trend data (↗/↘) — not included in the existing Bernd section either
- Changes to report format or structure

---

## Testing

After adding the sections:

1. Trigger a manual evening review for Bernhardine via Telegram or cron dry-run:
   `/plur1bus obsidian evening-review` sent to the `bernhardine` session
2. Confirm the report includes an "Emotionaler Zustand" or equivalent line
3. Verify the emotional state values match what's in
   `workspace-bernhardine/.emotional-state.json`
4. Repeat for Heisenberg's workspace

---

## Implementation notes

The `## Emotionaler Zustand` section is placed at the end of each AGENTS.md file
(after the existing "Make It Yours" / "Related" section). There is no specific ordering
requirement — the section just needs to be in AGENTS.md so it is loaded into LLM context.

The `.current-mood.txt` reference in the section is for future use — it is written by
`mood-carrier.sh` (context-check cron scripts) and provides a trend-aware summary.
If no context-check cron is configured for an agent, `.current-mood.txt` will not exist,
and the LLM will simply use `.emotional-state.json` alone.
