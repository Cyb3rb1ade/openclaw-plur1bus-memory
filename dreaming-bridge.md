# Dreaming Bridge — LanceDB → OpenClaw Dreaming

Bridges the `memory-lancedb-namespaced` plugin into OpenClaw's dreaming system
(`Leichtschlaf` / `Tiefschlaf` / `REM`), which normally requires the built-in
`memory-core` plugin.

Because `memory-lancedb-namespaced` holds the `plugins.slots.memory` slot,
`memory-core` is disabled — the dreaming-managed cron cannot run. These two
scripts replicate the relevant dreaming phases externally.

---

## Components

### `scripts/dreaming-bridge.py` — Leichtschlaf equivalent

Reads LanceDB memories (via `lancedb` Python client) and exports them as:

1. **Daily `.md` files** — `memory/YYYY-MM-DD.md` in each agent workspace,
   containing bridge entries with anchor comments for exact line tracking.

2. **`short-term-recall.json`** — OpenClaw's recall store format, stored at
   `memory/.dreams/short-term-recall.json`, ready for promotion.

On each subsequent run it also **refreshes** already-exported entries: adds
today to `recallDays` and increments `recallCount` — so the signal accumulates
across days without re-exporting duplicates.

**Config (top of file):**

```python
MIN_IMPORTANCE = 0.65   # LanceDB importance threshold for export
MAX_PER_DAY    = 30     # Max bridge entries written per daily file
```

**State** is tracked in `memory/.dreams/bridge-state.json` per workspace.
Exported IDs are never re-written; only recallDays are updated.

---

### `scripts/dreaming-promote.py` — Tiefschlaf equivalent

Reads `short-term-recall.json`, scores entries using OpenClaw's composite
algorithm, and promotes qualifying entries to `memory/MEMORY.md` with
`<!-- openclaw-memory-promotion:{key} -->` markers (compatible with OpenClaw's
deduplication logic).

**Promotion thresholds (OpenClaw defaults):**

| Parameter | Default | Meaning |
|---|---|---|
| `MIN_SCORE` | 0.75 | Composite score cutoff |
| `MIN_RECALL_COUNT` | 3 | Minimum signal count |
| `MIN_UNIQUE_QUERIES` | 2 | Minimum unique recallDays |
| `MAX_PROMOTE` | 10 | Max promotions per run per agent |

**Scoring weights** (matches `short-term-promotion-G9ML8hkA.js`):

| Component | Weight |
|---|---|
| frequency | 0.25 |
| relevance (avg score) | 0.30 |
| diversity (unique days) | 0.15 |
| recency (exponential decay, t½=14d) | 0.15 |
| consolidation | 0.10 |
| conceptual (concept tag count) | 0.05 |

Promoted entries are marked `promotedAt` in the recall store to prevent
re-promotion. The `MEMORY.md` marker format is identical to OpenClaw's native
output, so the built-in deduplication works if `memory-core` is ever re-enabled.

---

## Agents / Workspaces

| Namespace | Workspace |
|---|---|
| `main` | `/root/.openclaw/workspace` |
| `bernhardine` | `/root/.openclaw/workspace-bernhardine` |
| `heisenberg` | `/root/.openclaw/workspace-heisenberg` |

---

## Setup

### 1. Dependencies

```bash
pip install lancedb
```

`lancedb` must match the version used by the OpenClaw memory plugin.

### 2. Cron

```cron
# Dreaming Bridge — LanceDB → short-term-recall.json + daily .md files
30 23 * * * python3 /root/.openclaw/scripts/dreaming-bridge.py --quiet >> /root/.openclaw/logs/dreaming-bridge.log 2>&1

# Dreaming Promote — short-term-recall.json → MEMORY.md
35 23 * * * python3 /root/.openclaw/scripts/dreaming-promote.py --quiet >> /root/.openclaw/logs/dreaming-promote.log 2>&1
```

Bridge runs at 23:30, promote at 23:35. Both use `--quiet` in cron to suppress
the per-entry output (only errors and summary lines appear in the log).

### 3. Initial backfill

On first run, bridge exports all LanceDB memories above `MIN_IMPORTANCE` that
have `expiresAt=0` (permanent memories). Today's memories are skipped and
exported the following day.

The promote script requires entries to accumulate across ≥2 days before
promoting — run the bridge twice (on different calendar days) to see the first
promotions.

---

## File Layout (per workspace)

```
memory/
  YYYY-MM-DD.md           ← daily notes + bridge entries (anchor-commented)
  MEMORY.md               ← long-term promoted memories
  .dreams/
    short-term-recall.json  ← recall store (bridge writes, promote reads)
    bridge-state.json       ← exported IDs + per-entry importance
```

---

## Resetting

To reset a workspace's dream state without touching the daily files:

```bash
rm memory/.dreams/bridge-state.json
rm memory/.dreams/short-term-recall.json
```

The bridge will re-export everything from scratch on the next run.

To also remove bridge entries from daily files, delete the section starting at
the first `<!-- bridge-entry:` comment in each `.md` file.

---

## Version

`dreaming-bridge/v1.0.0` — 2026-04-06

Compatible with: `memory-lancedb-namespaced` ≥1.5, OpenClaw ≥2026.4.5
