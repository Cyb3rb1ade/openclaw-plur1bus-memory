# What's new in PLUR1BUS Memory 6.6.0 — Engram

**Release Date:** 2026-06-10

Three new cognitive layers ship in 6.6.0, expanding how your agent feels, anticipates, and reflects on its own memory.

---

## 🎭 Emotion Tier-Config (PR #19)

Fine-grained control over the emotion inference pipeline:

- **Budget-Gate per Tier** — Tier-1 (regex), Tier-2 (heuristic), and Tier-3 (LLM) can be enabled/disabled independently
- **Configurable model per tier** — use `gpt-4o-mini` for Tier-3 or bring your own via `baseUrl`/`apiKey`
- **Feature-Toggle** — `emotionTier` can be locked to a specific tier or set to `auto` for dynamic escalation
- **Graceful degradation** — if Tier-3 is enabled but no API key is available, the system falls back to Tier-2 without crashing

```json
{
  "emotion": {
    "tier": "auto",
    "t2": { "enabled": true },
    "t3": {
      "enabled": true,
      "model": "gpt-4o-mini",
      "apiKey": "${OPENAI_API_KEY}"
    }
  }
}
```

---

## 🔮 Proactive Nudges with Embedding Clustering (PR #20)

Your agent now surfaces contextual reminders before you ask:

- **Embedding-based pattern detection** — clusters similar turns by cosine similarity over embedding centroids
- **Cluster persistence** — clusters are stored per workspace/agent and survive restarts
- **Cooldown mechanism** — nudges are rate-limited to avoid spam (default: 24h per workspace)
- **Configurable thresholds** — `minClusterSize`, `similarityThreshold`, and `maxNudgesPerDay`

Run manually: `/plur1bus internal proactive-check`

---

## 🧠 Meta-Cognition (PR #21)

The agent can now reflect on its own recall quality:

- **Recall-Quality Metrics** — Precision, Recall, F1 computed from user feedback (`/mf +/-/~`)
- **Coverage-Gap Detection** — identifies topics with few memories or low `memoryStrength`
- **Threshold-based Reflection Trigger** — auto-runs when `sessionThreshold` (default: 50) or `intervalDays` (default: 7) is reached
- **Optional LLM Report** — generates a natural-language reflection summary when `llmReport: true`

State is persisted in `_meta-cognition-state.json` per workspace.

Run manually: `/plur1bus internal meta-reflect`

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
