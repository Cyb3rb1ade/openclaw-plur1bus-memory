# Spec C: Inner Continuity Engine — Integration Plan

**Plugin:** `cyb3rb1ade-plur1bus-memory`  
**Date:** 2026-06-12  
**Status:** Phase 4 implemented — contradiction-aware recall rendering and operator supersession available  
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
| `lib/recall-pipeline.js` | ⚠️ Partial | Has `graphEdges` + `associativeEnabled`, but **no** ContinuityGate, pattern surfacing, or overlay rendering |
| `lib/retroactive-interference.js` | ✅ Implemented | Spec B |

### Gap

The Inner Continuity Engine is **functionally complete in `plur1bus/`**, but **not integrated into the production root code path**. Root `index.js` still uses root `lib/recall-pipeline.js` and root `lib/relevant-memory-context.js` (the latter does not exist — formatting is inline in `index.js`).

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
4. Superseding without rewriting: overlay marks previous interpretation as `supersededBy` another overlay ID, not by mutating the factual record

### Phase 3: Contradiction Tracking + Inspection

**Goal:** Full belief revision semantics + operator tooling.

1. Detect contradictions between overlays (same target memory, conflicting meaning)
2. Track superseding interpretation lineage
3. Rollback/disable path for overlays
4. Audit/inspection tooling (CLI or memory-doctor command)
5. Stronger humility language for contradictory memories

---

## Configuration

```json
{
  "continuityEngine": {
    "enabled": true,
    "associativeRecall": {
      "enabled": true,
      "maxDepth": 3,
      "assocThreshold": 0.75,
      "maxTotal": 15
    },
    "patternSurfacing": {
      "enabled": true,
      "patternThreshold": 0.70,
      "maxPerSession": 1
    },
    "tasteGate": {
      "enabled": true,
      "maxAssociationsPerSession": 1,
      "maxPatternsPerSession": 1
    },
    "humility": {
      "enabled": true
    },
    "overlays": {
      "enabled": true,
      "autoCreateOnRecall": false,
      "maxAgeDays": 30
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
