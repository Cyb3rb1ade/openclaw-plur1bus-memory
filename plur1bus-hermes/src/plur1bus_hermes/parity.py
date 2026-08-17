"""Machine-readable PLUR1BUS-to-Hermes feature parity report."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from typing import Any


FEATURES: tuple[dict[str, str], ...] = (
    {"id": "capture-recall", "status": "ready", "evidence": "runtime capture, vector recall, reranking"},
    {"id": "agent-isolation", "status": "ready", "evidence": "per-agent LanceDB, Neo, state, workspace"},
    {"id": "omlx-providers", "status": "ready", "evidence": "LLM config plus embedding and /v1/rerank adapters"},
    {"id": "legacy-reembedding", "status": "ready", "evidence": "resumable source-text re-embedding with dimension guard"},
    {"id": "legacy-artifacts", "status": "ready", "evidence": "metadata, Neo, archives, workspaces, vault, markdown"},
    {"id": "embedding-cache", "status": "ready", "evidence": "agent-scoped LRU TTL and SQLite WAL"},
    {"id": "llm-result-cache", "status": "ready", "evidence": "purpose allowlist, hashed inputs, coalescing"},
    {"id": "memory-graph", "status": "ready", "evidence": "edges, link index, semantic communities, ANN rebuild"},
    {"id": "semantic-lens", "status": "ready", "evidence": "additive post-recall booster"},
    {"id": "conversation-reactivation", "status": "ready", "evidence": "idle-gap additive reactivation"},
    {"id": "episodes-emotion-temporal", "status": "ready", "evidence": "turn journal, episodes, emotion state, temporal hints"},
    {"id": "memory-dynamics", "status": "ready", "evidence": "strength decay maintenance and consolidation report"},
    {"id": "dreaming", "status": "ready", "evidence": "bounded REM phases with deterministic local fallback"},
    {"id": "critical-push", "status": "ready", "evidence": "classification, review ledger, stale auto-accept"},
    {"id": "feedback", "status": "ready", "evidence": "adaptive feedback ledger and dynamics inputs"},
    {"id": "reminder-state", "status": "ready", "evidence": "due, pending export, acknowledge, cancel"},
    {"id": "shared-memory-copy", "status": "ready", "evidence": "explicit agent-scoped sharing"},
    {"id": "obsidian-basic", "status": "ready", "evidence": "mirror, managed graph block, hash-tracked inbound sync"},
    {"id": "controls", "status": "ready", "evidence": "status, CRUD, graph, dreams, reminders, jobs, doctor"},
    {"id": "scheduler", "status": "ready", "evidence": "locked hourly/daily jobs and launchd installer"},
    {"id": "backup-cutover", "status": "ready", "evidence": "gated profile cutover and expanded backup roots"},
    {"id": "contradiction-live", "status": "ready", "evidence": "nearest-card capture scoring, graph edge, review disclosure"},
    {"id": "proactive-delivery", "status": "ready", "evidence": "authorized pre-gateway route, deduplicated async adapter delivery"},
    {"id": "identity-authorization", "status": "ready", "evidence": "pre-gateway MessageEvent identity, user allowlist, private-chat fallback"},
    {"id": "confirmation-bound-mutations", "status": "ready", "evidence": "one-time nonce bound to exact command, user, chat and expiry"},
    {"id": "obsidian-advanced", "status": "ready", "evidence": "managed dashboard, Bases, tasks, conflict report, weekly synthesis"},
    {"id": "speaker-mapping", "status": "ready", "evidence": "persistent aliases, turn segmentation, controls mapping"},
    {"id": "code-index", "status": "ready", "evidence": "bounded Python, JavaScript, TypeScript workspace symbol index"},
    {"id": "afterthought-meta-cognition", "status": "ready", "evidence": "additive confidence, continuity, temporal, contradiction overlay"},
    {"id": "explainable-recall", "status": "ready", "evidence": "per-result vector/rerank rationale and bounded decision trace"},
    {"id": "proactive-pattern-nudges", "status": "ready", "evidence": "persistent cosine clusters, cooldown, daily governor, outbox delivery"},
    {"id": "afterthought-followups", "status": "ready", "evidence": "30-120 minute open-outcome gate and shared governor"},
    {"id": "meta-reflection", "status": "ready", "evidence": "feedback precision, recall, F1 and coverage-gap state"},
    {"id": "temperament-mood", "status": "ready", "evidence": "presets, persistent mood files, capture stamp, recall context"},
    {"id": "multi-namespace-recall", "status": "ready", "evidence": "single writer, read-only legacy routes, globally bounded rerank and dedupe"},
    {"id": "shared-memory-pools", "status": "ready", "evidence": "hashed workspace/user pools, copy-never-move, additive vector recall"},
    {"id": "recall-hardening", "status": "ready", "evidence": "adaptive caps, long-input compression, exact canonical dedupe"},
    {"id": "long-input-commands", "status": "ready", "evidence": "semantic preparation for recall, forget, correct and 100k source guidance"},
    {"id": "correction-reinforcement", "status": "ready", "evidence": "archive-first correction plus retrieval count, timestamp and strength boost"},
    {"id": "gc-compaction-conflicts", "status": "ready", "evidence": "proposal-only merges, conflict recommendations, archive-first expiry GC"},
    {"id": "feature-profiles-toggles", "status": "ready", "evidence": "read-only choices, explicit safe/recommended apply, atomic whitelisted toggles"},
    {"id": "job-rate-limits", "status": "ready", "evidence": "persisted per-agent hourly, daily and weekly gates plus overlap lock"},
    {"id": "emotion-tier-routing", "status": "ready", "evidence": "T1/T2 plus configured OpenAI-compatible oMLX T3 and explicit T2 fallback"},
    {"id": "temporal-query-ranges", "status": "ready", "evidence": "relative day, last-month and quarter ranges filter Lance recall"},
    {"id": "poor-result-query-refinement", "status": "ready", "evidence": "one bounded content-focused second query before global rerank"},
    {"id": "critical-push-budget", "status": "ready", "evidence": "exactly-once classification ledger and persisted per-agent daily max"},
    {"id": "epistemic-capture", "status": "ready", "evidence": "observed/untrusted capture decision, restore-safe fail-closed cutoff, legacy rows stay unstamped"},
    {"id": "inject-budget", "status": "ready", "evidence": "recall.globalInjectMaxChars default 17000 caps memory context before structural blocks"},
    {"id": "tombstone-bulk-writers", "status": "ready", "evidence": "migration and workspace-migration reinserts pass the canonical scope-bound tombstone guard"},
    {"id": "derived-record-visibility", "status": "ready", "evidence": "dream records carry visibility stamps beside physical scope partitions and the own-agent legacy fallback"},
    {"id": "inject-marker-line-headers", "status": "ready", "evidence": "runtime inject headers recognized only as line headers in capture trust decisions"},
    {"id": "skill-farming", "status": "excluded", "evidence": "explicitly excluded by migration scope"},
    {"id": "curation-drop-injected", "status": "excluded", "evidence": "no neo-conflict or injected behavior-card surface exists in Hermes; upstream-only contracts"},
)


def parity_report() -> dict[str, Any]:
    """Return stable feature statuses and completion counts."""
    counts = Counter(feature["status"] for feature in FEATURES)
    required = [feature for feature in FEATURES if feature["status"] != "excluded"]
    ready = [feature for feature in required if feature["status"] == "ready"]
    return {
        "status": "ready" if len(ready) == len(required) else "incomplete",
        "readyRequired": len(ready),
        "totalRequired": len(required),
        "counts": dict(counts),
        "features": list(FEATURES),
    }


def main(argv: list[str] | None = None) -> int:
    """Print the parity report; --strict fails while required gaps remain."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--strict", action="store_true")
    arguments = parser.parse_args(argv)
    report = parity_report()
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if arguments.strict and report["status"] != "ready" else 0


if __name__ == "__main__":
    raise SystemExit(main())
