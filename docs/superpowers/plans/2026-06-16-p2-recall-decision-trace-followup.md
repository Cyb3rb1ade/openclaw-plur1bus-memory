# P2 RecallDecisionTrace — Followup

## 1. Summary

Implemented P2 RecallDecisionTrace / Memory Explainability end-to-end. Every memory that reaches the prompt, every rejected candidate, and every store-time merge/dedup/superseded decision is now explainable, testable, and auditable. The feature is opt-in and disabled by default. No vector DB dimensions, embedding models, LanceDB schema, or existing memory semantics were changed.

## 2. Files changed

| File | Change |
|------|--------|
| `index.js` | Wires trace collection through auto-recall, manual recall, store paths, contradiction detection, and prompt rendering. |
| `lib/recall-decision-trace.js` | New pure helper module for creating and manipulating trace objects. |
| `lib/recall-pipeline.js` | Instruments vector/canonical/graph scoring, dedup, rerank, ACL, and recall budget decisions. |
| `lib/continuity-gate.js` | Records associative/pattern guard allow/deny decisions. |
| `lib/memory-graph.js` | Records graph-only vs overlap merge decisions. |
| `lib/conversation-reactivation-recall.js` | Records reactivation candidate selection/rejection. |
| `lib/relevant-memory-context.js` | Renders opt-in `<memory-decision-trace>` block and per-memory trace attributes. |
| `openclaw.plugin.json` | Adds `recall.decisionTrace` config block. |
| `tests/recall-decision-trace.test.js` | Unit tests for the pure trace helper. |
| `tests/recall-pipeline-decision-trace.test.js` | Recall pipeline trace integration tests. |
| `tests/relevant-memory-context-trace.test.js` | Prompt rendering trace tests. |
| `tests/auto-recall-decision-trace.test.js` | Auto-recall and reactivation trace tests. |
| `tests/memory-store-decision-trace.test.js` | Store-time dedup/merge/superseded trace tests. |
| `tests/config-audit.test.js` | Schema default audits for new config keys. |

## 3. Trace data model

Trace objects are plain JS objects created by `createRecallDecisionTrace(opts)`. They contain:

- `id`, `createdAt`, `query`, `mode` — recall/auto-recall/store/diagnostic
- `candidates[]` — each candidate records `memoryId`, `textPreview`, `source`, `stage`, scores, `rank`, `depth`, `evidence`, `reason`, `guards[]`, `relatedMemoryIds[]`
- `guards[]` — `name`, `stage`, `result` (allow/deny/downrank/mark/skip), `memoryId`, `reason`
- `storeDecisions[]` — `type`, `memoryId`, `relatedMemoryId`, `reason`, `score`
- `summary` — counts of included/rejected/graph/vector/canonical/reactivation/contradictions/superseded

Trace metadata is attached to memory objects via a non-enumerable Symbol so it does not leak into JSON or prompts unless explicitly rendered.

## 4. Config keys

Under `recall.decisionTrace` in `openclaw.plugin.json`:

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `enabled` | boolean | `false` | Master switch for trace collection. |
| `includeInPrompt` | boolean | `false` | Render `<memory-decision-trace>` block in prompt. |
| `maxCandidates` | number | `50` | Cap on candidates kept in trace. |
| `maxTextPreviewChars` | number | `160` | Max chars for text previews. |
| `persist` | boolean | `false` | Reserved for future trace persistence. |
| `visibleHints` | boolean | `false` | Reserved for future user-visible hint text. |

## 5. Examples

### Diagnostic prompt block (when `includeInPrompt: true`)

```xml
<memory-decision-trace>
  <summary included="2" rejected="1" graph="1" vector="1" canonical="0" reactivation="0" contradictions="0" superseded="0"/>
  <included id="m123" source="vector" score="0.842" evidence="direct" reason="top vector match; passed dedup guard"/>
  <included id="m456" source="graph" score="0.421" evidence="weak-association" reason="graph association depth=1; passed continuity gate"/>
  <rejected id="m789" source="graph" reason="below association threshold"/>
</memory-decision-trace>
```

### Store-time trace decision

```json
{
  "type": "unsafe_duplicate_rejected",
  "memoryId": "new-mem-id",
  "relatedMemoryId": "existing-mem-id",
  "reason": "high similarity but meaningful difference detected",
  "score": 0.97
}
```

## 6. What is traced

### Recall-time
- Vector candidates, score filter, query refinement, temporal filter
- Canonical KNOWLEDGE.md hits
- Importance/emotion/strength re-scoring
- Graph-only and vector+graph overlap candidates
- Graph hydration relevance drops
- Recall budget tier caps
- Rerank fallback
- Jaccard dedup
- ACL denials
- Continuity gate associative/pattern allow/deny
- Overlay contradiction flagging
- Memory-text contradiction winner/loser
- Conversation reactivation selection/rejection
- Final prompt inclusion with source and reason

### Store-time
- Duplicate checks: safe duplicate accepted, unsafe duplicate rejected
- Merge candidate discovery
- Meaningful-difference guard abort
- LLM merge allow/abort
- Fact-preservation guard abort
- Archive-first merge persistence
- Normal separate store
- Superseded/contradiction decisions

## 7. What is intentionally not traced

- Full raw user prompts (only sanitized previews)
- LLM internal chain-of-thought
- Secrets or credentials
- Per-token embedding internals
- Vector DB query plans
- Other agents' private memory scopes (ACL still enforced)

## 8. Default behavior

Trace is completely disabled by default. Normal prompts are byte-for-byte identical to before. No extra log writes, no extra LLM calls, no DB changes. When enabled, trace collection is O(n) over already-collected candidates and is designed to be cheap.

## 9. How to enable diagnostic prompt trace

Set in `openclaw.plugin.json`:

```json
{
  "recall": {
    "decisionTrace": {
      "enabled": true,
      "includeInPrompt": true
    }
  }
}
```

Then restart the plugin. The `<memory-decision-trace>` block will appear inside `<relevant-memories>` for debugging.

## 10. Vector DB dimension invariance statement

This change does not:
- add, remove, or modify any LanceDB table columns;
- change the embedding model or its dimensions;
- change vector schema;
- require re-embedding;
- require DB migration.

Trace metadata lives in-memory and is emitted through existing callbacks, return values, and optional JSONL logs.

## 11. Tests

New tests:
- `tests/recall-decision-trace.test.js` — 28 unit tests
- `tests/recall-pipeline-decision-trace.test.js` — recall pipeline integration
- `tests/relevant-memory-context-trace.test.js` — prompt rendering
- `tests/auto-recall-decision-trace.test.js` — auto-recall + reactivation
- `tests/memory-store-decision-trace.test.js` — store-time decisions

All existing tests from #49/#50/#51/#52 remain green.

## 12. Remaining risks

| Risk | Mitigation |
|------|------------|
| Two parallel `memory_store` code paths could diverge in trace behavior | Both paths were instrumented with the same trace steps; unification is future work. |
| Large trace objects in high-volume deployments | `maxCandidates` caps trace size; disabled by default. |
| Prompt noise if `includeInPrompt` enabled globally | Documented as diagnostic-only; operators should enable selectively. |
| Trace metadata accidentally serialized | Stored via non-enumerable Symbol; serialization tests added. |
| Future recall algorithm changes may need trace updates | Trace calls are localized and easy to adjust. |

## 13. PR recommendation

Approve and merge after reviewer confirmation that:
- trace is diagnostic-only and does not alter ranking;
- default config leaves prompts unchanged;
- store-time #52 and contradiction #51 behavior is traced;
- no vector/embedding/schema changes occurred;
- full test suite passes.
