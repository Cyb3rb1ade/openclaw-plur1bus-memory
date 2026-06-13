# Spec C: Inner Continuity Engine — Integration Plan

**Plugin:** `cyb3rb1ade-plur1bus-memory`  
**Date:** 2026-06-12  
**Status:** Phase 5 implemented — auto-contradiction resolution on overlay generation available behind guardrails  
**Depends on:**
- Spec A (2026-06-11-human-memory-spec-a.md) — degraded-recall framing
- Spec B (2026-06-11-spec-b-retroactive-interference.md) — retroactive interference
- correction-as-recall (2026-06-09-correction-as-recall.md)

---

## Core Rule

> Never rewrite the past. Revise the meaning of the past.

## Architectural Constraint (Hard)

Factual memory records are append-only. Reconsolidation must never mutate or overwrite factual memory in-place. Deletion/forget flows use explicit tombstone semantics.

---

## Current State

### What already exists in `plur1bus/` (tested, 150 tests passing)

| Module | Status | Purpose |
|--------|--------|---------|
| `plur1bus/lib/continuity-gate.js` | ✅ Implemented | Taste gate for associative + pattern surfacing |
| `plur1bus/lib/interpretation-overlay.js` | ✅ Implemented | Append-only JSONL overlay store |
| `plur1bus/lib/pattern-surface.js` | ✅ Implemented | REM pattern scoring + humility formatting |
| `plur1bus/lib/relevant-memory-context.js` | ✅ Implemented | Context formatter with depth/faded/overlay support |
| `plur1bus/lib/recall-pipeline.js` | ✅ Implemented | Orchestrator with associative spread + pattern surfacing |
| `plur1bus/lib/memory-graph.js` | ✅ Re-export | Points to root `lib/memory-graph.js` |

### What already exists in root `lib/`

| Module | Status | Notes |
|--------|--------|-------|
| `lib/memory-graph.js` | ✅ Implemented | Graph traversal, edge building, merge logic |
| `lib/emotional-state.js` | ✅ Implemented | Stress-congruent recall boost (Spec A) |
| `lib/recall-pipeline.js` | ✅ Implemented | Orchestrator with associative spread + pattern surfacing + overlay rendering |
| `lib/retroactive-interference.js` | ✅ Implemented | Spec B |
| `lib/contradiction-detector.js` | ✅ Implemented | Detects and persists contradictions between meaning overlays |
| `lib/overlay-generator.js` | ✅ Implemented | Generates provisional overlays on recall |
| `lib/overlay-commands.js` | ✅ Implemented | `plur1bus memory` overlay audit subcommands |
| `lib/continuity-gate.js` | ✅ Implemented | Taste gate for associative + pattern surfacing |
| `lib/interpretation-overlay.js` | ✅ Implemented | Append-only JSONL overlay store |
| `lib/pattern-surface.js` | ✅ Implemented | REM pattern scoring + humility formatting |
| `lib/relevant-memory-context.js` | ✅ Implemented | Context formatter with depth/faded/overlay support |
| `lib/memory-context-sanitize.js` | ✅ Implemented | Context sanitizers extracted from `index.js` |

### Gap

The Inner Continuity Engine is now integrated into the production root code path via `index.js`. The remaining work is stabilization, expanded test coverage, and optional multi-agent shared overlays.

---

## Integration Strategy

Do **not** reimplement. Port and wire the existing `plur1bus/` modules into root.

### Files to port from `plur1bus/` to root

| Source | Destination | Change |
|--------|-------------|--------|
| `plur1bus/lib/continuity-gate.js` | `lib/continuity-gate.js` | Copy as-is |
| `plur1bus/lib/interpretation-overlay.js` | `lib/interpretation-overlay.js` | Copy as-is |
| `plur1bus/lib/pattern-surface.js` | `lib/pattern-surface.js` | Copy as-is |
| `plur1bus/lib/memory-context-sanitize.js` | `lib/memory-context-sanitize.js` | Extract from current `index.js` inline sanitizers |
| `plur1bus/lib/relevant-memory-context.js` | `lib/relevant-memory-context.js` | New formatter replacing inline formatting |
| `plur1bus/lib/recall-pipeline.js` | `lib/recall-pipeline.js` | Merge differences carefully; root has modules `plur1bus/` lacks |
| `plur1bus/tests/*.test.js` | `tests/` or `test/` | Port/adapt tests to root test runner |

### Files to modify in root

| File | Change |
|------|--------|
| `index.js` | Import from `lib/relevant-memory-context.js`; pass `graphSource`/`depth` to items; wire pattern surfacing config; wire overlay loading/rendering |
| `openclaw.plugin.json` / `openclaw.json` | Add `continuityEngine` feature flags |

---

## Phased Rollout

### Phase 1: Foundation + Safety Boundary

**Goal:** Bring associative recall, taste gate, humility, and minimal overlay storage into production.

1. **Port modules** from `plur1bus/lib/` to `lib/`
2. **Extract sanitizers** from `index.js` into `lib/memory-context-sanitize.js` (breaks circular import)
3. **Create `lib/relevant-memory-context.js`** replacing inline memory context formatting
4. **Update `lib/recall-pipeline.js`** to use `ContinuityGate` and `findBestPattern`
5. **Update `index.js`** to:
   - import new formatter
   - pass `graphSource`, `depth` per item
   - load overlays via `InterpretationOverlayStore`
   - pass `matchedPattern` and `overlays` to formatter
   - add `continuityEngine` config read
6. **Feature-flag everything** under `continuityEngine.*`
7. **Minimal overlay writes:** only create simple overlays on explicit trigger (not auto-on-store yet)
8. **Tombstone semantics:** ensure `status: "forgotten"` records are excluded; never mutate original records

**Tests:** Port `plur1bus/tests/` to root test runner. Add integration test that root recall-pipeline surfaces an associative memory through the gate.

### Phase 2: Rich Reconsolidation Overlays

**Goal:** Meaning drift, confidence changes, unresolved-thread updates.

1. Auto-create overlays when a memory is recalled in a new emotional/contextual frame
2. Overlay types: `meaning`, `confidence`, `context`, `unresolved-thread`
3. Provenance chain: every overlay points to `triggerMemoryIds` and source conversation
4. Superseding without rewriting: a new overlay record links to the previous interpretation via `supersedes`, leaving the original record append-only.

### Phase 3: Contradiction Tracking + Inspection

**Goal:** Full belief revision semantics + operator tooling.

1. Detect contradictions between overlays (same target memory, conflicting meaning)
2. Track superseding interpretation lineage
3. Rollback/disable path for overlays
4. Audit/inspection tooling (CLI or memory-doctor command)
5. Stronger humility language for contradictory memories

### Phase 4: Contradiction-Aware Recall + Operator Resolution

**Goal:** Surface contradictions during recall rendering and give operators a way to resolve them.

1. Add `ContradictionDetector.flagContradictoryOverlays` to mark active overlays that participate in a persisted contradiction.
2. Wire the enrichment into the recall path so contradictory memories render stronger humility language.
3. Add `InterpretationOverlayStore.supersedeOverlay(oldId, newDescription, reason)` for explicit operator resolution.
4. Add the `plur1bus memory supersede-overlay` command, gated by destructive auth and audit logging.

### Phase 5: Auto-Contradiction Resolution on Generation

**Goal:** Detect when a newly generated meaning overlay contradicts an existing active meaning overlay and automatically append it as a supersession resolution.

1. Extend `ContradictionDetector` with single-pair and single-vs-list helpers and a public `persistContradiction` audit writer.
2. Extend `OverlayGenerator` to check active meaning overlays for the same target after a `meaning` shift is generated.
3. When a contradiction is found, set `supersedes` on the new overlay, mark it `active`, and attach `autoContradiction` metadata.
4. The caller appends the new overlay and then persists the contradiction record, so audit entries are never written for failed appends.
5. Gate the behavior behind `continuityEngine.overlays.autoResolveContradictions` (default `false`).
6. Wire the merging LLM through `index.js` for the contradiction check.

#### Overlay record fields

- `id` (UUID), `targetMemoryId`, `createdAt`, `shiftType`, `shiftDescription`, `confidence`, `confidenceDelta`, `triggerContext`, `dedupeKey`, `provenance`.
- `status`: `"active"`, `"provisional"`, or `"forgotten"`.
- `supersedes`: id of an older overlay this record replaces.
- `autoContradiction`: optional metadata attached during generation when the overlay auto-resolves a contradiction; contains `targetMemoryId`, `overlayA` (new), `overlayB` (existing).

---

## Configuration

Default configuration (features are individually gated; enable as needed):

```json
{
  "continuityEngine": {
    "enabled": false,
    "associativeRecall": {
      "enabled": true,
      "maxDepth": 3,
      "assocThreshold": 0.75,
      "maxNeighborsPerNode": 8,
      "maxAssociatedResults": 40,
      "minCumulativeRelevance": 0.2
    },
    "patternSurfacing": {
      "enabled": false,
      "patternThreshold": 0.70,
      "maxPerSession": 1
    },
    "tasteGate": {
      "enabled": true,
      "maxAssociationsPerSession": 1,
      "maxPatternsPerSession": 1
    },
    "overlays": {
      "enabled": true,
      "autoCreateOnRecall": false,
      "autoResolveContradictions": false,
      "provisionalByDefault": true,
      "maxAgeDays": 30,
      "confidenceThreshold": 0.7,
      "maxPerSession": 3
    }
  }
}
```

---

## Safety Properties

| Property | Enforcement |
|----------|-------------|
| No hallucinated memories | Graph-only results hydrated from LanceDB; pattern surfacing uses stored pattern records |
| No fabricated certainty | `confidence` attribute on every surfaced association; humility framing for weak/inferred |
| No in-place corruption | `InterpretationOverlayStore` only appends JSONL; factual records never updated by overlay logic |
| Clear provenance | Every overlay has `provenance.triggerMemoryIds` + `createdAt` |
| Taste gate prevents over-association | `ContinuityGate` rate limits + score thresholds + depth limits |
| Overlays reversible | JSONL append-only; rollback reads all overlays and filters by ID or time |
| Deletion explicit | Tombstone `status: "forgotten"` appended; original record retained |

---

## Test Requirements

### Ported from `plur1bus/tests/`

- `continuity-gate.test.js`
- `interpretation-overlay.test.js`
- `pattern-surface.test.js`
- `spreading-activation-recall.test.js`
- `recall-pipeline-pattern.test.js`
- `relevant-memory-context.test.js`

### New integration tests

- Root `index.js` uses `lib/relevant-memory-context.js` without circular imports
- Associative recall surfaces through root recall pipeline when feature flag is on
- Pattern surfacing produces `<memory-continuity>` block in context
- Overlay store appends without mutating LanceDB
- Tombstone records are filtered from recall results

---

## Out of Scope

- Reimplementing graph traversal (already in `lib/memory-graph.js`)
- Reimplementing emotional-state boosts (Spec A)
- Reimplementing retroactive interference (Spec B)
- Multi-agent shared overlays (future)

---

## Success Criteria

With `continuityEngine.enabled: true`, PLUR1BUS should occasionally say:

> "This may connect to something we discussed before…"

or

> "Back then it looked like X; now it may mean Y."

only when the association is useful, natural, and grounded — and never by falsifying the original memory record.
