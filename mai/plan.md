# PLUR1BUS Emotion Integration — Implementation Plan

## Project Context
- **Base repo**: `/private/tmp/memory-analysis` (Node.js OpenClaw plugin)
- **Work directory**: `/private/tmp/memory-analysis/mai`
- **Language**: JavaScript (ES modules), adapting Python spec to existing JS codebase
- **Constraint**: No commit, no push. Work stays in `mai/`.

## Existing Codebase Facts
- `lib/emotion.js` — heuristic emotion inference (7 Plutchik dimensions)
- `lib/emotional-state.js` — EmotionalState tracker with decay
- `lib/db-adapter.js` — LanceDB adapter
- `lib/episodes.js` — episode management
- `lib/graph-index.js` — graph edges
- Package: `@lancedb/lancedb` for vector DB, `openai` for LLM
- Tests: Node.js native test runner (`node --test`)

## Coordination Spec

### Status: ✅ COMPLETE
All 5 groups implemented, tested, and validated. No commits, no pushes.

### Shared Contracts
- **EmotionScore** class: `{valence, arousal, dominance, intensity, primary_emotion, secondary_emotion, emotion_labels, language, source, tier_used, confidence, timestamp}`
- **VAD bounds**: valence/arousal/dominance in [-1, 1], intensity/confidence in [0, 1]
- **Tier routing**: Tier1 (lexicon, ~0.01ms) → Tier2 (transformer, ~0.01ms stub) → Tier3 (LLM, ~0ms fallback)
- **Engram emotion field**: `emotion: EmotionScore | null`
- **Decay formula**: `H(e) = H_base * (1 + intensity² * k) * (1 + |valence| * 0.3)`

### Module Groups — All Implemented

#### Group 1 — Core Emotion System ✅
**Files**: `mai/emotion-score.js`, `mai/tier1-lexicon.js`, `mai/tier2-transformer.js`, `mai/tier3-llm.js`, `mai/emotion-engine.js`
**Validation**: `node --check` passed + `tier1-classifier.test.js` (5 tests) + `emotion-engine.test.js` (6 tests)

#### Group 2 — Storage Integration ✅
**Files**: `mai/lancedb-schema.js`, `mai/engram-emotion.js`, `mai/edge-emotion.js`, `mai/card-tags.js`, `mai/obsidian-export.js`
**Validation**: `node --check` passed + `engram-decay.test.js` (7 tests) + `edge-context.test.js` (5 tests) + `obsidian-tags.test.js` (6 tests)

#### Group 3 — Process Modules ✅
**Files**: `mai/decay-engine.js`, `mai/recall-engine.js`, `mai/dreaming-engine.js`
**Validation**: `node --check` passed + `engram-decay.test.js` (DecayEngine) + `edge-context.test.js` (RecallEngine)

#### Group 4 — New Modules ✅
**Files**: `mai/mood-tracker.js`, `mai/narrative-engine.js`, `mai/context-weight.js`, `mai/response-modulator.js`, `mai/contagion-guard.js`, `mai/emotion-bus.js`
**Validation**: `node --check` passed + `mood-narrative.test.js` (9 tests) + `bus-guard-modulator.test.js` (14 tests)

#### Group 5 — Integration & Tests ✅
**Files**: `mai/lifecycle.js`, `mai/tests/*.test.js` (8 files, 62 tests), `mai/benchmarks/emotion-benchmark.js`
**Validation**: All 62 tests pass, benchmark runs successfully

## Additional Deliverables
- `mai/index.js` — Barrel export of all modules
- `mai/README.md` — Full documentation with quickstart, API reference, test results
- `mai/pluribus_emotion_architecture.svg` — Architecture diagram (copied from prompt attachment)

## Merge Order
1. ✅ Groups 1-4 ran in parallel via subagents
2. ✅ Group 5 ran after Groups 1-4
3. ✅ Main agent reviewed all outputs, fixed integration issues
4. ✅ Final validation: `node --test mai/tests/*.test.js` — 62 pass, 0 fail

## Quality Gates — All Passed
- ✅ Every module: `node --check` passes (20/20 files)
- ✅ Every module exports public API
- ✅ 62 tests covering: EmotionScore validation, Tier1 classification, Decay formula, Mood tracking, Narrative arcs, Edge weighting, Bus/Guard/Modulator, Obsidian export
- ✅ Benchmark measures Tier1 latency (p50 = 0.01ms, target <5ms)
- ✅ Barrel export (`index.js`) for clean imports
- ✅ README with quickstart and architecture diagram
