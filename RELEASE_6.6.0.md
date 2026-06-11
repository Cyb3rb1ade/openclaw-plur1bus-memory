# PLUR1BUS Memory 6.6.0 — Engram: Meta-Cognition

**Release Date:** 2026-06-10

The final cognitive layer of Engram: your agent now reflects on its own memory usage.

---

## 🧠 Meta-Cognition (PR #21)

The agent can now introspect its own recall performance and identify blind spots:

### Recall-Quality Metrics

- **Precision, Recall, F1** computed from user feedback (`/mf +/-/~`)
- Per-workspace aggregation with persistent state in `_meta-cognition-state.json`
- Tracks both positive and negative signals over time

### Coverage-Gap Detection

- Identifies topics with **few memories** (< 3 entries)
- Flags topics with **low `memoryStrength`** (< 0.3 average)
- Sorted by gap severity for prioritized attention

### Threshold-Based Reflection Trigger

Auto-runs when either condition is met:
- `sessionThreshold`: N sessions since last reflection (default: 50)
- `intervalDays`: Days since last reflection (default: 7)

### Optional LLM Report

When `llmReport: true`, generates a natural-language reflection summary:
```json
{
  "metaCognition": {
    "enabled": true,
    "sessionThreshold": 50,
    "intervalDays": 7,
    "llmReport": true
  }
}
```

### Manual Trigger

```bash
/plur1bus internal meta-reflect
```

---

## What's in the full Engram release (6.3–6.6)

| Version | Feature | PR |
|---------|---------|-----|
| 6.3.0 | Explainability, GC Job, Feedback Analyzer | #15 |
| 6.4.0 | Emotion Tier-Config (Budget-Gate per Tier) | #19 |
| 6.5.0 | Proactive Nudges with Embedding Clustering | #20 |
| **6.6.0** | **Meta-Cognition** | **#21** |

---

## Install / Update

```bash
# Fresh install
openclaw plugins install clawhub:memory-lancedb-namespaced

# Update
openclaw plugins update memory-lancedb-namespaced
```

---

## Full Changelog

See [CHANGELOG.md](./CHANGELOG.md).

---

**PLUR1BUS Memory** — *Make your agent yours.*
