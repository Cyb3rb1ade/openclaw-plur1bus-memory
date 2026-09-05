"""Machine-readable PLUR1BUS-to-Hermes feature parity report."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from typing import Any


FEATURES: tuple[dict[str, str], ...] = (
    {"id": "capture-recall", "status": "partial", "evidence": "native lifecycle capture/vector recall; upstream capture, TTL and store contracts differ"},
    {"id": "agent-isolation", "status": "ready", "evidence": "per-agent LanceDB, Neo, state, workspace"},
    {"id": "omlx-providers", "status": "ready", "evidence": "LLM config plus embedding and /v1/rerank adapters"},
    {"id": "legacy-reembedding", "status": "partial", "evidence": "resumable staged batches plus explicit activate/recover for one private writer; named namespaces and non-cooperating runtimes are unsupported"},
    {"id": "legacy-artifacts", "status": "partial", "evidence": "selected metadata and artifacts; no complete export/restore workflow"},
    {"id": "embedding-cache", "status": "partial", "evidence": "agent-scoped persistence and single/batch in-flight coalescing; exact upstream cache and byte-pruning contract differs"},
    {"id": "llm-result-cache", "status": "partial", "evidence": "native cache integration is narrower than the upstream contract"},
    {"id": "memory-graph", "status": "partial", "evidence": "native graph and recall edges; extended graph contracts differ"},
    {"id": "semantic-lens", "status": "partial", "evidence": "default-off additive booster with category caps and elapsed-time guard; full upstream contract not claimed"},
    {"id": "conversation-reactivation", "status": "partial", "evidence": "native session-aware reactivation, not every upstream trigger"},
    {"id": "episodes-emotion-temporal", "status": "partial", "evidence": "turn journal and temporal fields; episode/emotion contracts differ"},
    {"id": "memory-dynamics", "status": "partial", "evidence": "strength/consolidation is not upstream TTL or store-merge parity"},
    {"id": "dreaming", "status": "partial", "evidence": "bounded REM and fallback; full dream workflow differs"},
    {"id": "critical-push", "status": "partial", "evidence": "authorized own-reply action bound to scoped host message ID/route and latest ledger state; reactions lack a general-plugin hook"},
    {"id": "feedback", "status": "partial", "evidence": "manual feedback exists; automatic outcome tracking is absent"},
    {"id": "reminder-state", "status": "partial", "evidence": "opt-in absolute-time extraction produces private pending proposals; explicit confirmation schedules an existing scoped card"},
    {"id": "shared-memory-copy", "status": "ready", "evidence": "explicit agent-scoped sharing"},
    {"id": "obsidian-basic", "status": "partial", "evidence": "mirror, explicit sync and revision-bound CLI consent; browser discovery, watch and conflict workflows differ"},
    {"id": "controls", "status": "partial", "evidence": "native commands cover an intentionally narrower operator surface"},
    {"id": "scheduler", "status": "partial", "evidence": "macOS launchd jobs; no cross-platform Hermes scheduler equivalent"},
    {"id": "backup-cutover", "status": "partial", "evidence": "backup roots and gated cutover; no complete export/restore"},
    {"id": "contradiction-live", "status": "partial", "evidence": "native graph/review disclosure; independent upstream disclosure config and formatting differ"},
    {"id": "proactive-delivery", "status": "partial", "evidence": "opt-in independent in-process ticks after authorized route registration; cold restart needs a fresh gateway event"},
    {"id": "identity-authorization", "status": "ready", "evidence": "pre-gateway MessageEvent identity, user allowlist, private-chat fallback"},
    {"id": "confirmation-bound-mutations", "status": "ready", "evidence": "one-time nonce bound to exact command, user, chat and expiry"},
    {"id": "obsidian-advanced", "status": "partial", "evidence": "managed native files, not the full dynamic operator workflow"},
    {"id": "speaker-mapping", "status": "ready", "evidence": "persistent aliases, turn segmentation, controls mapping"},
    {"id": "code-index", "status": "ready", "evidence": "bounded Python, JavaScript, TypeScript workspace symbol index"},
    {"id": "afterthought-meta-cognition", "status": "partial", "evidence": "additive hints, not full configurable session-LLM reporting"},
    {"id": "explainable-recall", "status": "ready", "evidence": "per-result vector/rerank rationale and bounded decision trace"},
    {"id": "proactive-pattern-nudges", "status": "partial", "evidence": "native patterns/governor; no independent delivery"},
    {"id": "afterthought-followups", "status": "partial", "evidence": "native governor; no independent delivery"},
    {"id": "meta-reflection", "status": "partial", "evidence": "aggregate feedback, not full upstream reflection contract"},
    {"id": "temperament-mood", "status": "partial", "evidence": "mood presets/context; Persona Voice and full style contract differ"},
    {"id": "multi-namespace-recall", "status": "ready", "evidence": "single writer, read-only legacy routes, globally bounded rerank and dedupe"},
    {"id": "shared-memory-pools", "status": "ready", "evidence": "hashed workspace/user pools, copy-never-move, additive vector recall"},
    {"id": "recall-hardening", "status": "partial", "evidence": "native caps/compression; fallback and validity-aware behavior differ"},
    {"id": "long-input-commands", "status": "ready", "evidence": "semantic preparation for recall, forget, correct and 100k source guidance"},
    {"id": "correction-reinforcement", "status": "partial", "evidence": "archive-first correction; safe-update and merge-lineage contracts differ"},
    {"id": "gc-compaction-conflicts", "status": "partial", "evidence": "explicit merge proposals include repair of metadata/mirror/cognition/graph materialization before source retirement; upstream automatic compaction differs"},
    {"id": "feature-profiles-toggles", "status": "partial", "evidence": "atomic native allowlist, not full upstream configuration mapping"},
    {"id": "job-rate-limits", "status": "ready", "evidence": "persisted per-agent hourly, daily and weekly gates plus overlap lock"},
    {"id": "emotion-tier-routing", "status": "partial", "evidence": "local-only lazy Transformer/prototype T2 or explicit T1 fallback; configured T3; live model quality not verified"},
    {"id": "temporal-query-ranges", "status": "partial", "evidence": "validAt and created-time ranges exist; full historical store-merge contract is absent"},
    {"id": "poor-result-query-refinement", "status": "ready", "evidence": "one bounded content-focused second query before global rerank"},
    {"id": "critical-push-budget", "status": "ready", "evidence": "exactly-once classification ledger and persisted per-agent daily max"},
    {"id": "epistemic-capture", "status": "ready", "evidence": "observed/untrusted capture decision, restore-safe fail-closed cutoff, legacy rows stay unstamped"},
    {"id": "inject-budget", "status": "ready", "evidence": "recall.globalInjectMaxChars default 17000 caps memory context before structural blocks"},
    {"id": "tombstone-bulk-writers", "status": "ready", "evidence": "migration and workspace-migration reinserts pass the canonical scope-bound tombstone guard"},
    {"id": "derived-record-visibility", "status": "ready", "evidence": "dream records carry visibility stamps beside physical scope partitions and the own-agent legacy fallback"},
    {"id": "inject-marker-line-headers", "status": "ready", "evidence": "runtime inject headers recognized only as line headers in capture trust decisions"},
    {"id": "critical-batch", "status": "ready", "evidence": "ACL-bound snapshot, multiple refs/all, per-card error isolation"},
    {"id": "operator-status", "status": "ready", "evidence": "server-scoped dashboard status plus reviewed session-bound Workshop actions and explicit local CLI"},
    {"id": "physical-compaction", "status": "ready", "evidence": "explicit operator CLI --apply, exact writer route, no semantic GC"},
    {"id": "private-dream-diary", "status": "ready", "evidence": "private-only idempotent managed DREAMS.md block"},
    {"id": "skill-farming", "status": "partial", "evidence": "opt-in procedural proposals, evidence hashes, exact revision approval and conflict-safe native publication; published skills are profile-wide"},
    {"id": "curation-drop-injected", "status": "excluded", "evidence": "no neo-conflict or injected behavior-card surface exists in Hermes; upstream-only contracts"},
)

# Keep legacy native-runtime readiness distinct from full new upstream coverage.
# A passing legacy capability inventory must never imply a full 7.10 port.
COVERAGE_710 = (
    {"id": "validity-and-expiry", "status": "partial", "detail": "native validAt/validity windows and absolute expiresAt exist; complete TTL and historical merge parity is not claimed"},
    {"id": "store-merge-lineage", "status": "partial", "detail": "explicit lossless-concatenation proposals, stable IDs, validity lineage, approved revision and final revalidation; repair restores metadata/mirror/cognition/graph materialization before source retirement; automatic store-time LLM merge remains absent"},
    {"id": "llm-result-cache", "status": "partial", "detail": "native cache integration is narrower than the complete upstream live-call contract"},
    {"id": "reminder-extraction", "status": "partial", "detail": "absolute-time opt-in extraction and scoped pending confirmation implemented; relative dates are deliberately not guessed"},
    {"id": "cognition-tiers", "status": "partial", "detail": "opt-in Persona Voice, knowledge promotion, LightDream, LLM reflection and scoped episode narrative jobs; reaction events and complete graph/entity parity remain open"},
    {"id": "local-jina-v3", "status": "not-ported", "detail": "native Transformers remote-code chain is not independently audited; explicit fail-closed guard, existing sidecar model support retained"},
    {"id": "dashboard", "status": "partial", "detail": "server-scoped status plus reviewed Workshop approve/publish previews and session-bound one-use actions; no generic operator command or full workflow UI"},
    {"id": "reembedding", "status": "partial", "detail": "bounded staged batches plus explicit activate/recover under cooperating runtime leases; named namespaces, non-cooperating processes and automatic switching are unsupported"},
    {"id": "trusted-critical-reply", "status": "partial", "detail": "own-reply flag plus scoped outgoing message ID/route and fresh authorization gate explicit outcomes; no generic reaction hook"},
    {"id": "skill-workshop", "status": "partial", "detail": "native mine/show/approve/publish workflow with source revalidation and no manual overwrite; native publication is profile-wide, not agent-ACL protected"},
    {"id": "obsidian-operator-ui", "status": "partial", "detail": "native mirror retained and source import has revision-bound local CLI consent; browser target discovery and consent UI are not reproduced"},
    {"id": "proactive-delivery", "status": "partial", "detail": "independent async ticks after one authorized gateway route registration; no durable cold-start route ownership"},
    {"id": "openclaw-host-internals", "status": "host-specific", "detail": "public SDK memory slot, Cron ownership, iframe actions and native dream renderer have no identical Hermes interface"},
)


def parity_report() -> dict[str, Any]:
    """Return the legacy inventory and the authoritative 7.10 coverage gate."""
    counts = Counter(feature["status"] for feature in FEATURES)
    required = [feature for feature in FEATURES if feature["status"] != "excluded"]
    ready = [feature for feature in required if feature["status"] == "ready"]
    coverage_status = "partial"
    return {
        # ``status`` is intentionally the release/cutover status.  The legacy
        # inventory below remains useful evidence, but cannot claim complete
        # v7.10 parity while COVERAGE_710 has known gaps.
        "status": "complete" if coverage_status == "complete" else coverage_status,
        "legacyInventoryStatus": "ready" if len(ready) == len(required) else "incomplete",
        "readyRequired": len(ready),
        "totalRequired": len(required),
        "counts": dict(counts),
        "features": list(FEATURES),
        "coverageVersion": "7.10.0",
        "coverageStatus": coverage_status,
        "coverage710": list(COVERAGE_710),
    }


def main(argv: list[str] | None = None) -> int:
    """Print the parity report; --strict fails while required gaps remain."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--strict", action="store_true")
    arguments = parser.parse_args(argv)
    report = parity_report()
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if arguments.strict and report["coverageStatus"] != "complete" else 0


if __name__ == "__main__":
    raise SystemExit(main())
