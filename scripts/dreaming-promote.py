#!/usr/bin/env python3
"""
dreaming-promote.py — Tiefschlaf (Deep Sleep) equivalent for OpenClaw
                      Promotes short-term memories → MEMORY.md

Reads short-term-recall.json (populated by dreaming-bridge.py),
scores entries using OpenClaw's composite algorithm, and writes
promoted entries to MEMORY.md with openclaw-memory-promotion markers.

Run: python3 /root/.openclaw/scripts/dreaming-promote.py
Cron: daily at 23:35 (5 minutes after dreaming-bridge.py at 23:30)
"""

import json
import math
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────────────────

AGENTS = {
    "main":        Path("/root/.openclaw/workspace"),
    "bernhardine": Path("/root/.openclaw/workspace-bernhardine"),
    "heisenberg":  Path("/root/.openclaw/workspace-heisenberg"),
}

# OpenClaw source defaults (from short-term-promotion-G9ML8hkA.js)
MIN_SCORE          = 0.75
MIN_RECALL_COUNT   = 3
MIN_UNIQUE_QUERIES = 2   # minUniqueQueries = unique recallDays
HALF_LIFE_DAYS     = 14
MAX_PROMOTE        = 10  # max new promotions per run per agent

WEIGHTS = {
    "frequency":     0.25,
    "relevance":     0.30,
    "diversity":     0.15,
    "recency":       0.15,
    "consolidation": 0.10,
    "conceptual":    0.05,
}

PROMOTION_MARKER_PREFIX = "openclaw-memory-promotion:"

# ── Helpers ───────────────────────────────────────────────────────────────────

def now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat()

def today_iso() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%d")

def load_json(path: Path, default):
    try:
        return json.loads(path.read_text())
    except Exception:
        return default

def save_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    tmp.rename(path)

def clamp(v: float, lo=0.0, hi=1.0) -> float:
    return max(lo, min(hi, v))

# ── Scoring (mirrors OpenClaw JS algorithm) ───────────────────────────────────

def calc_recency(age_days: float, half_life: float) -> float:
    """Exponential decay: score=1 at age=0, score=0.5 at age=half_life"""
    if age_days <= 0:
        return 1.0
    return clamp(math.exp(-math.log(2) * age_days / half_life))

def calc_consolidation(recall_days: list) -> float:
    """Rewards spread-out recalls (not all same day)"""
    unique_days = len(set(recall_days))
    return clamp(unique_days / 5.0)

def calc_conceptual(concepts: list) -> float:
    """Rewards having many distinct concepts"""
    return clamp(len(set(concepts)) / 6.0)

def score_entry(entry: dict) -> float:
    signal_count   = entry.get("recallCount", 1)
    total_score    = entry.get("totalScore", 0.0)
    recall_days    = entry.get("recallDays", [])
    concepts       = entry.get("concepts", [])

    avg_score  = clamp(total_score / max(1, signal_count))
    frequency  = clamp(math.log1p(signal_count) / math.log1p(10))
    diversity  = clamp(len(set(recall_days)) / 5.0)

    # Recency: based on most recent recallDay
    today = today_iso()
    most_recent = max(recall_days) if recall_days else today
    try:
        age_days = (
            datetime.fromisoformat(today) - datetime.fromisoformat(most_recent)
        ).days
    except Exception:
        age_days = 0

    recency       = calc_recency(age_days, HALF_LIFE_DAYS)
    consolidation = calc_consolidation(recall_days)
    conceptual    = calc_conceptual(concepts)

    return (
        WEIGHTS["frequency"]     * frequency     +
        WEIGHTS["relevance"]     * avg_score     +
        WEIGHTS["diversity"]     * diversity     +
        WEIGHTS["recency"]       * recency       +
        WEIGHTS["consolidation"] * consolidation +
        WEIGHTS["conceptual"]    * conceptual
    )

# ── Snippet rehydration ───────────────────────────────────────────────────────

def rehydrate_snippet(workspace: Path, entry: dict) -> str:
    """
    Try to get the actual text from the daily file.
    Falls back to the stored snippet.
    Uses fuzzy search if line numbers are off.
    """
    stored_snippet = entry.get("snippet", "").strip()
    rel_path  = entry.get("path", "")
    start     = entry.get("startLine", 0)
    end       = entry.get("endLine", 0)

    if not rel_path or not start:
        return stored_snippet

    file_path = workspace / rel_path
    if not file_path.exists():
        return stored_snippet

    try:
        lines = file_path.read_text().splitlines()
        # Try exact line range (1-indexed → 0-indexed)
        chunk = lines[start - 1 : end]
        if chunk:
            text = " ".join(l.strip() for l in chunk if l.strip())
            if text:
                return text[:300]
    except Exception:
        pass

    return stored_snippet

# ── Promotion marker handling ─────────────────────────────────────────────────

_MARKER_RE = re.compile(
    r"<!--\s*" + re.escape(PROMOTION_MARKER_PREFIX) + r"([^\s>]+)\s*-->"
)

def extract_existing_promotion_keys(memory_md: Path) -> set:
    """Return set of keys already promoted (from marker comments)."""
    if not memory_md.exists():
        return set()
    keys = set()
    for line in memory_md.read_text().splitlines():
        m = _MARKER_RE.search(line)
        if m:
            keys.add(m.group(1))
    return keys

# ── MEMORY.md writing ─────────────────────────────────────────────────────────

def build_promotion_block(candidates: list, workspace: Path) -> str:
    """Build the promotion section text to append to MEMORY.md."""
    today = today_iso()
    lines = [
        "",
        f"## Promoted From Short-Term Memory ({today})",
        "",
    ]
    for entry, composite in candidates:
        key     = entry["_key"]
        snippet = rehydrate_snippet(workspace, entry)
        src     = entry.get("path", "?")
        sl      = entry.get("startLine", 0)
        el      = entry.get("endLine", 0)
        rc      = entry.get("recallCount", 1)
        ts      = entry.get("totalScore", 0.0)
        avg_sc  = round(ts / max(1, rc), 3)

        lines.append(f"<!-- {PROMOTION_MARKER_PREFIX}{key} -->")
        lines.append(
            f"- {snippet[:200]} "
            f"[score={composite:.3f} recalls={rc} avg={avg_sc:.3f} "
            f"source={src}:{sl}-{el}]"
        )
    lines.append("")
    return "\n".join(lines)

def append_to_memory_md(memory_md: Path, block: str):
    if memory_md.exists():
        existing = memory_md.read_text()
        # Ensure one trailing newline before appending
        if not existing.endswith("\n"):
            existing += "\n"
    else:
        existing = "# Memory\n\n"
    memory_md.write_text(existing + block + "\n")

# ── Core per-agent processing ─────────────────────────────────────────────────

def process_agent(namespace: str, workspace: Path, verbose: bool = True) -> dict:
    store_path  = workspace / "memory" / ".dreams" / "short-term-recall.json"
    memory_md   = workspace / "memory" / "MEMORY.md"

    if not store_path.exists():
        return {"skipped": True, "reason": "no recall store"}

    store = load_json(store_path, {"version": 1, "entries": {}})
    entries_raw = store.get("entries", {})

    if not entries_raw:
        return {"namespace": namespace, "promoted": 0, "candidates": 0}

    # Filter existing promotions (deduplication)
    existing_keys = extract_existing_promotion_keys(memory_md)

    # Build candidate list
    candidates = []
    for key, entry in entries_raw.items():
        # Skip already promoted
        if key in existing_keys:
            continue
        if entry.get("promotedAt"):
            continue

        # Eligibility checks (OpenClaw defaults)
        recall_count   = entry.get("recallCount", 1)
        recall_days    = entry.get("recallDays", [])
        unique_queries = len(set(recall_days))

        if recall_count < MIN_RECALL_COUNT:
            continue
        if unique_queries < MIN_UNIQUE_QUERIES:
            continue

        entry["_key"] = key
        composite = score_entry(entry)
        if composite < MIN_SCORE:
            continue

        candidates.append((entry, composite))

    candidates.sort(key=lambda x: x[1], reverse=True)
    to_promote = candidates[:MAX_PROMOTE]

    if not to_promote:
        return {"namespace": namespace, "promoted": 0, "candidates": len(candidates)}

    # Build and append promotion block
    block = build_promotion_block(to_promote, workspace)
    memory_md.parent.mkdir(parents=True, exist_ok=True)
    append_to_memory_md(memory_md, block)

    # Mark entries as promoted in recall store
    now = now_iso()
    for entry, _ in to_promote:
        key = entry["_key"]
        entries_raw[key]["promotedAt"] = now

    store["updatedAt"] = now
    save_json(store_path, store)

    return {
        "namespace": namespace,
        "promoted":  len(to_promote),
        "candidates": len(candidates),
    }


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    verbose = "--quiet" not in sys.argv

    total_promoted = 0
    for namespace, workspace in AGENTS.items():
        if not workspace.exists():
            continue
        result = process_agent(namespace, workspace, verbose)
        if result.get("skipped"):
            if verbose:
                print(f"[promote] {namespace}: skipped ({result.get('reason')})")
            continue
        p = result.get("promoted", 0)
        c = result.get("candidates", 0)
        total_promoted += p
        if verbose or p > 0:
            print(f"[promote] {namespace}: {p} promoted ({c} candidates above threshold)")

    if verbose:
        print(f"[promote] done — {total_promoted} total promotions across all agents")


if __name__ == "__main__":
    main()
