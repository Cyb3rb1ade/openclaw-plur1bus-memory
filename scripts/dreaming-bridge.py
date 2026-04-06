#!/usr/bin/env python3
"""
dreaming-bridge.py — Bridges memory-lancedb-namespaced → OpenClaw Dreaming system

Exports LanceDB memories as daily .md files and populates short-term-recall.json
so the dreaming system (Leichtschlaf/Tiefschlaf/REM) can process them.

Run: python3 /root/.openclaw/scripts/dreaming-bridge.py
Cron: daily at 23:30 (before dreaming light-sleep typically runs at midnight)
"""

import json
import os
import sys
import hashlib
from datetime import datetime, timezone
from pathlib import Path

try:
    import lancedb
except ImportError:
    print("lancedb not available, skipping bridge", file=sys.stderr)
    sys.exit(0)

# ── Config ────────────────────────────────────────────────────────────────────

LANCEDB_BASE = Path("/root/.openclaw/memory/lancedb-namespaced")
MIN_IMPORTANCE = 0.65   # Only memories above this score are exported
MAX_PER_DAY = 30        # Max entries per daily file (avoid giant files)

AGENTS = {
    "main":        Path("/root/.openclaw/workspace"),
    "bernhardine": Path("/root/.openclaw/workspace-bernhardine"),
    "heisenberg":  Path("/root/.openclaw/workspace-heisenberg"),
}

# ── Helpers ───────────────────────────────────────────────────────────────────

def iso_day(ts_ms: float) -> str:
    """Unix timestamp (ms) → YYYY-MM-DD"""
    return datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")

def today_iso() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%d")

def now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat()

def recall_store_path(workspace: Path) -> Path:
    return workspace / "memory" / ".dreams" / "short-term-recall.json"

def daily_file_path(workspace: Path, day: str) -> Path:
    return workspace / "memory" / f"{day}.md"

def state_file_path(workspace: Path) -> Path:
    return workspace / "memory" / ".dreams" / "bridge-state.json"

def entry_key(path_rel: str, start: int, end: int) -> str:
    return f"memory:{path_rel}:{start}:{end}"

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

def extract_concepts(text: str) -> list[str]:
    """Very simple concept extraction — pull out notable tokens."""
    STOP = {
        "das", "die", "der", "den", "dem", "des", "ein", "eine", "einen", "einer",
        "und", "oder", "aber", "mit", "von", "bei", "für", "auf", "aus", "nach",
        "the", "and", "for", "with", "from", "that", "this", "are", "was", "not",
        "ist", "sind", "wird", "wurde", "hat", "haben", "kann", "kein", "keine",
    }
    import re
    tokens = re.findall(r'[A-Za-zÄÖÜäöüß]{4,}', text)
    seen = set()
    result = []
    for tok in tokens:
        low = tok.lower()
        if low not in STOP and low not in seen:
            seen.add(low)
            result.append(low)
        if len(result) >= 8:
            break
    return result

# ── Core: build daily file + recall store entries ─────────────────────────────

def process_agent(namespace: str, workspace: Path, verbose: bool = True) -> dict:
    db_path = LANCEDB_BASE / namespace
    if not db_path.exists():
        return {"skipped": True, "reason": "no db"}

    try:
        db = lancedb.connect(str(db_path))
        tbl = db.open_table("memories")
    except Exception as e:
        return {"skipped": True, "reason": str(e)}

    # Load existing state (which IDs we've already exported)
    state_path = state_file_path(workspace)
    state = load_json(state_path, {"exported_ids": {}, "version": 1})
    exported_ids: dict = state.get("exported_ids", {})

    # Query memories above threshold, newest first
    rows = tbl.search().limit(10000).to_list()
    eligible = [
        r for r in rows
        if float(r.get("importance", 0) or 0) >= MIN_IMPORTANCE
        and r.get("id") not in exported_ids
        and int(r.get("expiresAt", 0) or 0) == 0  # skip expiring entries
    ]

    # Load existing recall store
    store_path = recall_store_path(workspace)
    store = load_json(store_path, {"version": 1, "updatedAt": now_iso(), "entries": {}})
    if "entries" not in store:
        store["entries"] = {}

    # Refresh pass — update recallDays for already-exported entries so that
    # accumulated daily bridge runs build up the signal needed for promotion.
    today_str = today_iso()
    refresh_count = 0
    for rid, meta in exported_ids.items():
        key = meta.get("key")
        if not key or key not in store["entries"]:
            continue
        entry = store["entries"][key]
        recall_days = entry.get("recallDays", [])
        if today_str not in recall_days:
            recall_days.append(today_str)
            entry["recallDays"] = recall_days
            entry["recallCount"] = entry.get("recallCount", 1) + 1
            # totalScore accumulates: add importance from original export
            orig_importance = meta.get("importance", 0.7)
            entry["totalScore"] = round(
                entry.get("totalScore", 0.0) + orig_importance, 4
            )
            refresh_count += 1

    if verbose and refresh_count:
        print(f"[bridge] {namespace}: refreshed recallDays for {refresh_count} existing entries")

    if not eligible and refresh_count == 0:
        return {"namespace": namespace, "new_entries": 0, "total_eligible": 0}

    # Group new entries by day
    by_day: dict[str, list] = {}
    for row in eligible:
        ts = float(row.get("createdAt", 0) or 0)
        day = iso_day(ts) if ts > 0 else today_iso()
        by_day.setdefault(day, []).append(row)

    new_count = 0
    today = today_iso()

    for day, entries in sorted(by_day.items()):
        # Don't write today's entries yet — let them accumulate first
        if day == today:
            continue

        daily_path = daily_file_path(workspace, day)
        rel_path = f"memory/{day}.md"

        # Load or initialize the daily file
        if daily_path.exists():
            existing_lines = daily_path.read_text().splitlines()
        else:
            existing_lines = [f"# Memory Notes — {day}", ""]

        # Append new entries (up to MAX_PER_DAY total bridge entries per day)
        bridge_marker = "<!-- bridge-entry:"
        existing_bridge_count = sum(1 for l in existing_lines if bridge_marker in l)

        added_to_file = []
        pending = []  # collect entries first, resolve line numbers after write

        for row in entries[:max(0, MAX_PER_DAY - existing_bridge_count)]:
            rid = row.get("id", "")
            text = (row.get("text", "") or "").strip()
            summary = (row.get("summary", "") or text[:80]).strip()
            importance = float(row.get("importance", 0.7) or 0.7)

            if not text or len(text) < 10:
                continue

            text_lines = text.splitlines() or [""]
            # Unique anchor comment used to locate lines after write
            anchor = f"<!-- bridge-entry:{rid} score={importance:.2f} -->"
            block = [
                "",
                anchor,
                f"## {summary[:80]}",
                "",
            ] + text_lines + ["", ""]
            existing_lines.extend(block)
            pending.append({"rid": rid, "anchor": anchor, "importance": importance,
                            "snippet": text[:300].replace("\n", " ").strip(),
                            "text_len": len(text_lines), "day": day, "rel_path": rel_path,
                            "concepts": extract_concepts(text)})
            added_to_file.append(rid)
            new_count += 1

        if added_to_file:
            daily_path.parent.mkdir(parents=True, exist_ok=True)
            daily_path.write_text("\n".join(existing_lines) + "\n")

            # Resolve accurate line numbers by scanning the written file
            written_lines = daily_path.read_text().splitlines()
            anchor_index = {}  # anchor → (line_index_0based of anchor comment)
            for i, line in enumerate(written_lines):
                if line.startswith("<!-- bridge-entry:"):
                    # Extract rid from anchor
                    try:
                        rid_part = line.split("bridge-entry:")[1].split(" ")[0]
                        anchor_index[rid_part] = i
                    except Exception:
                        pass

            for p in pending:
                rid = p["rid"]
                anchor_i = anchor_index.get(rid)
                if anchor_i is None:
                    continue
                # Text starts 3 lines after the anchor (anchor, heading, empty, TEXT)
                text_start_i = anchor_i + 3  # 0-based index
                text_end_i = text_start_i + p["text_len"] - 1  # inclusive 0-based
                start_line = text_start_i + 1  # convert to 1-indexed
                end_line = text_end_i + 1

                importance = p["importance"]
                recall_count = 3 if importance >= 0.9 else (2 if importance >= 0.75 else 1)
                key = entry_key(p["rel_path"], start_line, end_line)
                store["entries"][key] = {
                    "path": p["rel_path"],
                    "source": "memory",
                    "startLine": start_line,
                    "endLine": end_line,
                    "snippet": p["snippet"],
                    "recallCount": recall_count,
                    "totalScore": round(importance * recall_count, 4),
                    "recallDays": [p["day"]],
                    "concepts": p["concepts"],
                }
                exported_ids[rid] = {"day": p["day"], "key": key, "importance": importance}

    # Persist recall store and state
    store["updatedAt"] = now_iso()
    save_json(store_path, store)

    state["exported_ids"] = exported_ids
    state["lastRun"] = now_iso()
    save_json(state_path, state)

    return {"namespace": namespace, "new_entries": new_count, "total_eligible": len(eligible) + len(exported_ids)}


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    verbose = "--quiet" not in sys.argv

    total_new = 0
    for namespace, workspace in AGENTS.items():
        if not workspace.exists():
            continue
        result = process_agent(namespace, workspace)
        if result.get("skipped"):
            if verbose:
                print(f"[bridge] {namespace}: skipped ({result.get('reason')})")
            continue
        new = result.get("new_entries", 0)
        total = result.get("total_eligible", 0)
        total_new += new
        if verbose or new > 0:
            print(f"[bridge] {namespace}: {new} new entries exported ({total} total eligible)")

    if verbose:
        print(f"[bridge] done — {total_new} new entries across all agents")


if __name__ == "__main__":
    main()
