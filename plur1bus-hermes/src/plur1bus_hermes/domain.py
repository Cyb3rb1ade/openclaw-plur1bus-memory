"""PLUR1BUS domain features shared by the Hermes provider and controls."""

from __future__ import annotations

import hashlib
import json
import math
import re
import threading
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .cognition import (
    analyze_text,
    analyze_text_tiered,
    contradiction_score,
    extract_open_threads,
)
from .code_index import query_code_index, rebuild_code_index
from .critical import classify_critical
from .critical_review import assign_short_refs, resolve_short_ref
from .dreaming import build_rem_dream
from .obsidian_maintenance import generate_obsidian_control_room
from .mood import MoodEngine
from .namespaces import (
    ScopeBinding,
    binding_from_scope,
    canonical_scope_binding,
    legacy_agent_private_scope_key,
    scope_where_clause,
)
from .proactive import ProactiveEngine
from .speakers import SpeakerMappingStore
from .shared_pools import SharedPoolStore, SharedPrincipal
from .validation import safe_memory_id

from .validation import safe_agent_id, safe_memory_id


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def _now_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def _normalized_text(value: str) -> str:
    return " ".join(str(value).lower().split())


@dataclass(frozen=True)
class _ScopeSelector:
    """One exact consumer scope, including the legacy private read path."""

    agent_id: str
    scope_key: str
    scope_type: str
    binding: ScopeBinding | None = None

    @property
    def acl_bindings(self) -> dict[str, str]:
        if self.binding is not None:
            return self.binding.as_dict()
        return {
            "agentId": self.agent_id,
            "scopeKey": self.scope_key,
            "scopeType": self.scope_type,
        }

    @property
    def include_legacy_private(self) -> bool:
        return self.scope_type == "agent-private"

    def where(self, suffix: str = "") -> str:
        if self.binding is not None:
            clause = scope_where_clause(self.binding)
        else:
            clause = (
                f"agentId = '{self.agent_id}' AND "
                f"scopeKey = '{self.scope_key.replace(chr(39), chr(39) * 2)}'"
            )
        return clause + suffix


def _row_scope_key(row: Mapping[str, Any]) -> str:
    direct = str(row.get("scopeKey") or "").strip()
    if direct:
        return direct
    acl = row.get("aclBindings")
    if isinstance(acl, Mapping):
        return str(acl.get("scopeKey") or acl.get("key") or "").strip()
    return ""


def _row_matches_scope(row: Mapping[str, Any], selector: _ScopeSelector) -> bool:
    row_agent = str(row.get("agentId") or "").strip()
    if row_agent and row_agent != selector.agent_id:
        return False
    row_scope_key = _row_scope_key(row)
    if not row_scope_key:
        return selector.include_legacy_private
    if row_scope_key == selector.scope_key:
        return True
    return selector.include_legacy_private and row_scope_key == legacy_agent_private_scope_key()


class Plur1busDomain:
    """Implement graph, vault, dynamics, dreaming, reminder, and feedback features."""

    def __init__(
        self,
        data_dir: Path,
        agent_id: str,
        config: dict[str, Any] | None = None,
    ) -> None:
        self.data_dir = data_dir
        self.config = dict(config or {})
        self.agent_id = safe_agent_id(agent_id)
        self.neo_dir = data_dir / "neo" / self.agent_id
        self.workspace_dir = data_dir / "profiles" / self.agent_id / "workspace"
        self.state_dir = data_dir / "state" / self.agent_id
        self._speakers = SpeakerMappingStore(self.neo_dir / "speaker-mappings.json")
        self._proactive = ProactiveEngine(
            self.state_dir, self.neo_dir, self.workspace_dir
        )
        self._mood = MoodEngine(self.workspace_dir)
        self._llm_backend = None
        self._lock = threading.RLock()
        self._last_recall_ms = 0

    def _scope_selector(
        self,
        *,
        acl_bindings: Any = None,
        scope_key: str | None = None,
        record: Mapping[str, Any] | None = None,
    ) -> _ScopeSelector:
        """Resolve one explicit canonical consumer scope without defaults."""
        if record is not None and acl_bindings is None and scope_key is None:
            record_scope_key = _row_scope_key(record)
            if record_scope_key:
                record_scope_type = str(
                    record.get("scopeType")
                    or record.get("scope_type")
                    or record.get("scope")
                    or "agent-private"
                ).strip()
                if record_scope_type != "agent-private":
                    return self._scope_selector(
                        acl_bindings={
                            "agentId": record.get("agentId") or self.agent_id,
                            "scopeType": record_scope_type,
                            "workspaceIdentity": record.get("workspaceIdentity")
                            or record.get("workspace"),
                            "platform": record.get("ownerPlatform")
                            or record.get("platform"),
                            "userId": record.get("ownerUser")
                            or record.get("userId"),
                            "chatId": record.get("chatScope")
                            or record.get("chatId"),
                            "account": record.get("account"),
                        },
                        scope_key=record_scope_key,
                    )
                return _ScopeSelector(
                    self.agent_id,
                    record_scope_key,
                    str(record.get("scopeType") or "agent-private"),
                )
            acl_bindings = record.get("aclBindings")

        binding: ScopeBinding | None = None
        if acl_bindings is not None:
            if isinstance(acl_bindings, ScopeBinding):
                binding = acl_bindings
            elif isinstance(acl_bindings, Mapping):
                provided_agent = str(acl_bindings.get("agentId") or self.agent_id).strip()
                if provided_agent != self.agent_id:
                    raise ValueError("ACL binding agent does not match domain agent")
                direct_key = str(
                    acl_bindings.get("scopeKey") or acl_bindings.get("key") or ""
                ).strip()
                scope_type = str(
                    acl_bindings.get("scopeType")
                    or acl_bindings.get("scope_type")
                    or acl_bindings.get("scope")
                    or ""
                ).strip()
                if direct_key and scope_type not in {"agent-private", "workspace", "user", "chat"}:
                    if scope_key and scope_key != direct_key:
                        raise ValueError("scopeKey does not match ACL binding")
                    return _ScopeSelector(self.agent_id, direct_key, "opaque")
                binding = canonical_scope_binding(
                    self.agent_id,
                    scopeType=scope_type or None,
                    workspaceIdentity=acl_bindings.get("workspaceIdentity")
                    or acl_bindings.get("workspace")
                    or acl_bindings.get("workspaceId"),
                    platform=acl_bindings.get("platform"),
                    userId=acl_bindings.get("userId")
                    or acl_bindings.get("user")
                    or acl_bindings.get("ownerUserId"),
                    chatId=acl_bindings.get("chatId")
                    or acl_bindings.get("chat")
                    or acl_bindings.get("chatScope"),
                    account=acl_bindings.get("account")
                    or acl_bindings.get("accountId"),
                )
            else:
                binding = binding_from_scope(self.agent_id, acl_bindings)
            if binding.agent_id != self.agent_id:
                raise ValueError("ACL binding agent does not match domain agent")
            if direct_key and direct_key != binding.scope_key:
                raise ValueError("ACL binding scopeKey is not canonical")
            if scope_key and scope_key != binding.scope_key:
                raise ValueError("scopeKey does not match ACL binding")
            return _ScopeSelector(self.agent_id, binding.scope_key, binding.scope_type, binding)

        if scope_key is not None:
            normalized_key = str(scope_key).strip()
            if not normalized_key:
                raise ValueError("scopeKey is required")
            return _ScopeSelector(self.agent_id, normalized_key, "opaque")

        binding = binding_from_scope(self.agent_id)
        return _ScopeSelector(self.agent_id, binding.scope_key, binding.scope_type, binding)

    def _scope_for_rows(
        self,
        rows: list[dict[str, Any]],
        *,
        acl_bindings: Any = None,
        scope_key: str | None = None,
    ) -> _ScopeSelector | None:
        """Infer a single row scope only when every candidate agrees."""
        if acl_bindings is not None or scope_key is not None:
            return self._scope_selector(acl_bindings=acl_bindings, scope_key=scope_key)
        keys = {_row_scope_key(row) for row in rows if _row_scope_key(row)}
        if len(keys) > 1:
            return None
        return self._scope_selector(scope_key=next(iter(keys))) if keys else self._scope_selector()

    @staticmethod
    def _filter_rows(rows: list[dict[str, Any]], selector: _ScopeSelector) -> list[dict[str, Any]]:
        return [row for row in rows if _row_matches_scope(row, selector)]

    def _metadata_rows_for_scope(self, selector: _ScopeSelector) -> list[dict[str, Any]]:
        """Filter metadata by its embedded binding before any consumer limit."""
        selected = []
        for row in self._metadata_rows():
            metadata = self._metadata_json(row)
            candidate = metadata if _row_scope_key(metadata) else row
            if _row_matches_scope(candidate, selector):
                selected.append(row)
        return selected

    def on_turn(
        self,
        user: str,
        assistant: str,
        session_id: str,
        *,
        acl_bindings: Any = None,
        scope_key: str | None = None,
        aclBindings: Any = None,
        scopeKey: str | None = None,
    ) -> None:
        """Persist a turn journal entry and a compact episodic record."""
        acl_bindings = aclBindings if aclBindings is not None else acl_bindings
        scope_key = scopeKey if scopeKey is not None else scope_key
        selector = self._scope_selector(acl_bindings=acl_bindings, scope_key=scope_key)
        now = _utcnow()
        turn_ids = []
        for index, (role, content) in enumerate((("user", user), ("assistant", assistant))):
            text = str(content or "").strip()
            if not text:
                continue
            analysis = analyze_text(text)
            turn_id = str(uuid.uuid4())
            turn_ids.append(turn_id)
            self._append_jsonl(self.neo_dir / "turn-journal.jsonl", {
                "id": turn_id,
                "workspaceKey": self.agent_id,
                "agentId": self.agent_id,
                "scopeKey": selector.scope_key,
                "aclBindings": selector.acl_bindings,
                "sessionId": session_id,
                "turnIndex": index,
                "role": role,
                "content": text,
                "categories": ["user_explicit" if role == "user" else "assistant_claim"],
                "cognition": analysis,
                "speakerSegments": self._speakers.segment(text),
                "visibility": {
                    "scope": "agent_private",
                    "recallable": True,
                    "promptInjectable": False,
                    "dreamEligible": role == "user",
                },
                "createdAt": now,
            })
        if turn_ids:
            combined = "\n".join(text for text in (user.strip(), assistant.strip()) if text)
            analysis = self._analyze_text(combined)
            mood = self._mood.update(analysis["emotion"])
            self._append_jsonl(self.neo_dir / "episodes.jsonl", {
                "id": str(uuid.uuid4()),
                "workspaceKey": self.agent_id,
                "agentId": self.agent_id,
                "scopeKey": selector.scope_key,
                "aclBindings": selector.acl_bindings,
                "title": f"Conversation {now[:10]}",
                "summary": combined[:1000],
                "startTime": now,
                "endTime": now,
                "memoryIds": [],
                "turnIds": turn_ids,
                "importance": self._importance(combined, "user"),
                "emotionalDominant": self._emotion(combined)[0],
                "emotionalIntensity": self._emotion(combined)[1],
                "emotionalValence": analysis["emotion"]["valence"],
                "factQuality": analysis["factQuality"],
                "temporal": analysis["temporal"],
                "moodContext": mood,
                "turnCount": len(turn_ids),
                "createdAt": now,
            })
            self._append_jsonl(self.neo_dir / "emotional-state.jsonl", {
                "agentId": self.agent_id,
                "scopeKey": selector.scope_key,
                "aclBindings": selector.acl_bindings,
                "sessionId": session_id,
                "createdAt": now,
                **analysis["emotion"],
            })
            for thread in extract_open_threads(user):
                self._append_jsonl(self.neo_dir / "open-threads.jsonl", {
                    "id": str(uuid.uuid4()),
                    "agentId": self.agent_id,
                    "scopeKey": selector.scope_key,
                    "aclBindings": selector.acl_bindings,
                    "sessionId": session_id,
                    "text": thread,
                    "status": "open",
                    "createdAt": now,
                })

    def on_memory(
        self,
        record: dict[str, Any],
        table: Any,
        *,
        acl_bindings: Any = None,
        scope_key: str | None = None,
        aclBindings: Any = None,
        scopeKey: str | None = None,
    ) -> None:
        """Materialize metadata, graph edges, critical state, and an Obsidian note."""
        acl_bindings = aclBindings if aclBindings is not None else acl_bindings
        scope_key = scopeKey if scopeKey is not None else scope_key
        selector = self._scope_selector(
            acl_bindings=acl_bindings,
            scope_key=scope_key,
            record=record,
        )
        record = {
            **record,
            "scopeKey": selector.scope_key,
            "scopeType": selector.scope_type,
            "aclBindings": selector.acl_bindings,
        }
        analysis = self._analyze_text(str(record.get("content") or ""))
        self._append_jsonl(self.neo_dir / "memory-cognition.jsonl", {
            "id": record["id"],
            "agentId": self.agent_id,
            "scopeKey": selector.scope_key,
            "aclBindings": selector.acl_bindings,
            "createdAt": _utcnow(),
            **analysis,
        })
        self._store_metadata(record)
        self._write_obsidian_note(record)
        self._build_graph_edges(record, table)
        metadata = self._metadata_for(record)
        source_role = str(record.get("sourceRole") or "")
        critical = classify_critical(
            str(record.get("content") or ""),
            metadata,
            source_role=source_role,
        )
        classifications = self._read_jsonl(
            self.state_dir / "critical-classification.jsonl"
        )
        if any(str(item.get("id") or "") == str(record["id"]) for item in classifications):
            return
        today = _utcnow()[:10]
        max_per_day = max(
            0,
            int((self.config.get("criticalPush") or {}).get("maxPerDay", 3)),
        )
        pushed_today = sum(
            str(item.get("createdAt") or "").startswith(today)
            and item.get("status") == "pending_review"
            for item in self._read_jsonl(self.state_dir / "critical-push.jsonl")
        )
        classification = {
            "id": record["id"],
            "agentId": self.agent_id,
            **critical,
            "classifiedAt": _utcnow(),
        }
        self._append_jsonl(
            self.state_dir / "critical-classification.jsonl",
            classification,
        )
        if critical["eligible"] and pushed_today < max_per_day:
            self._append_jsonl(self.state_dir / "critical-push.jsonl", {
                "id": record["id"],
                "agentId": self.agent_id,
                "importance": critical["importance"],
                "reason": critical["reason"],
                "sourceRole": source_role,
                "contentSuppressed": critical["suppressContent"],
                "status": "pending_review",
                "createdAt": _utcnow(),
            })
        elif critical["eligible"]:
            self._append_jsonl(self.state_dir / "critical-push.jsonl", {
                "id": record["id"],
                "agentId": self.agent_id,
                "importance": critical["importance"],
                "reason": critical["reason"],
                "sourceRole": source_role,
                "status": "budget_suppressed",
                "createdAt": _utcnow(),
            })

    def recall_overlay(
        self,
        query: str,
        rows: list[dict[str, Any]],
        *,
        acl_bindings: Any = None,
        scope_key: str | None = None,
        aclBindings: Any = None,
        scopeKey: str | None = None,
    ) -> str:
        """Build an additive explainability and continuity block after normal recall."""
        acl_bindings = aclBindings if aclBindings is not None else acl_bindings
        scope_key = scopeKey if scopeKey is not None else scope_key
        selector = self._scope_for_rows(
            rows, acl_bindings=acl_bindings, scope_key=scope_key
        )
        rows = self._filter_rows(rows, selector) if selector is not None else []
        if not rows:
            return ""
        analysis = analyze_text(query)
        distances = [
            float(row["_distance"])
            for row in rows
            if row.get("_distance") is not None
        ]
        confidence = (
            max(0.0, min(1.0, 1.0 - min(distances)))
            if distances
            else 0.5
        )
        recalled_ids = {str(row.get("id") or "") for row in rows}
        contradictions = [
            item
            for item in self._read_jsonl(
                self.neo_dir / "contradiction-disclosure.jsonl"
            )
            if _row_matches_scope(item, selector)
            and (str(item.get("newMemoryId") or "") in recalled_ids
            or str(item.get("existingMemoryId") or "") in recalled_ids
            )
        ][-3:]
        open_threads = []
        if analysis["continuationSignal"] or analysis["question"]:
            latest: dict[str, dict[str, Any]] = {}
            for item in self._read_jsonl(self.neo_dir / "open-threads.jsonl"):
                thread_id = str(item.get("id") or "")
                if thread_id and _row_matches_scope(item, selector):
                    latest[thread_id] = item
            open_threads = [
                str(item.get("text") or "")
                for item in latest.values()
                if item.get("status") == "open"
            ][-3:]
        payload = {
            "confidence": round(confidence, 4),
            "recalledMemoryIds": sorted(recalled_ids),
            "temporalContext": analysis["temporal"],
            "openThreads": open_threads,
            "contradictionsRequireReview": [
                {
                    "newMemoryId": item.get("newMemoryId"),
                    "existingMemoryId": item.get("existingMemoryId"),
                    "score": item.get("score"),
                }
                for item in contradictions
            ],
            "additiveOnly": True,
            "mood": self._mood.state(),
        }
        return (
            "<memory-meta-cognition>\n"
            + json.dumps(payload, ensure_ascii=False, indent=2)
            + "\n</memory-meta-cognition>"
        )

    def explain_recall(
        self,
        rows: list[dict[str, Any]],
        *,
        acl_bindings: Any = None,
        scope_key: str | None = None,
        aclBindings: Any = None,
        scopeKey: str | None = None,
    ) -> str:
        """Render a bounded per-result score and provenance explanation."""
        acl_bindings = aclBindings if aclBindings is not None else acl_bindings
        scope_key = scopeKey if scopeKey is not None else scope_key
        selector = self._scope_for_rows(
            rows, acl_bindings=acl_bindings, scope_key=scope_key
        )
        rows = self._filter_rows(rows, selector) if selector is not None else []
        explanations = []
        for rank, row in enumerate(rows, start=1):
            distance = row.get("_distance")
            vector_score = (
                round(max(0.0, min(1.0, 1.0 - float(distance))), 4)
                if distance is not None
                else None
            )
            rerank_score = next(
                (
                    row.get(key)
                    for key in (
                        "_rerank_score",
                        "rerankScore",
                        "relevance_score",
                        "score",
                    )
                    if row.get(key) is not None
                ),
                None,
            )
            explanations.append({
                "rank": rank,
                "id": row.get("id"),
                "vectorScore": vector_score,
                "rerankScore": rerank_score,
                "status": row.get("status"),
                "sourceRole": row.get("sourceRole"),
                "boostedAdditively": rank > 5,
            })
        return (
            "<memory-recall-explain>\n"
            + json.dumps(
                {"results": explanations, "decisionTraceBounded": True},
                ensure_ascii=False,
                indent=2,
            )
            + "\n</memory-recall-explain>"
        )

    def boost_recall(
        self,
        rows: list[dict[str, Any]],
        table: Any,
        limit: int,
        *,
        acl_bindings: Any = None,
        scope_key: str | None = None,
        aclBindings: Any = None,
        scopeKey: str | None = None,
    ) -> list[dict[str, Any]]:
        """Append graph, semantic-lens, and reactivation candidates after base recall."""
        acl_bindings = aclBindings if aclBindings is not None else acl_bindings
        scope_key = scopeKey if scopeKey is not None else scope_key
        selector = self._scope_for_rows(
            rows, acl_bindings=acl_bindings, scope_key=scope_key
        )
        if selector is None:
            return []
        rows = self._filter_rows(rows, selector)
        if not rows:
            return rows
        seen = {str(row.get("id") or "") for row in rows}
        candidate_ids = self._graph_neighbor_ids(seen, scope_key=selector.scope_key)
        candidate_ids.update(self._semantic_lens_ids(seen, scope_key=selector.scope_key))
        now = _now_ms()
        if self._last_recall_ms and now - self._last_recall_ms >= 45 * 60 * 1000:
            candidate_ids.update(self._reactivation_ids(seen, scope_key=selector.scope_key))
        self._last_recall_ms = now
        hydrated = self._hydrate_ids(
            table,
            candidate_ids - seen,
            max(0, limit - len(rows)),
            scope_key=selector.scope_key,
        )
        return rows + hydrated

    def record_feedback(
        self,
        memory_id: str,
        feedback: str,
        query: str = "",
        *,
        acl_bindings: Any = None,
        scope_key: str | None = None,
        aclBindings: Any = None,
        scopeKey: str | None = None,
    ) -> dict[str, Any]:
        """Record useful, irrelevant, or incorrect feedback for later dynamics jobs."""
        acl_bindings = aclBindings if aclBindings is not None else acl_bindings
        scope_key = scopeKey if scopeKey is not None else scope_key
        selector = self._scope_selector(acl_bindings=acl_bindings, scope_key=scope_key)
        card_id = safe_memory_id(memory_id)
        normalized = str(feedback).strip().lower()
        if normalized not in {"useful", "irrelevant", "incorrect"}:
            raise ValueError("feedback must be useful, irrelevant, or incorrect")
        entry = {
            "id": str(uuid.uuid4()),
            "agentId": self.agent_id,
            "memoryId": card_id,
            "scopeKey": selector.scope_key,
            "aclBindings": selector.acl_bindings,
            "feedback": normalized,
            "queryHash": hashlib.sha256(query.encode("utf-8")).hexdigest() if query else "",
            "createdAt": _utcnow(),
        }
        self._append_jsonl(self.workspace_dir / ".adaptive-learning" / "feedback-log.jsonl", entry)
        return entry

    def share_memory(
        self,
        table: Any,
        memory_id: str,
        *,
        principal: SharedPrincipal | None = None,
        user_scope: bool = False,
        acl_bindings: Any = None,
        scope_key: str | None = None,
        aclBindings: Any = None,
        scopeKey: str | None = None,
    ) -> dict[str, Any]:
        """Publish an explicit card copy to the local shared-memory pool."""
        acl_bindings = aclBindings if aclBindings is not None else acl_bindings
        scope_key = scopeKey if scopeKey is not None else scope_key
        selector = self._scope_selector(acl_bindings=acl_bindings, scope_key=scope_key)
        card_id = safe_memory_id(memory_id)
        rows = table.search().where(
            f"id = '{card_id}' AND {selector.where()} AND status = 'active'"
        ).limit(1).to_list()
        rows = self._filter_rows(rows, selector)
        if not rows:
            raise ValueError("memory not found or inactive")
        card = rows[0]
        store = SharedPoolStore(
            self.data_dir,
            principal or SharedPrincipal(workspace=self.agent_id),
        )
        return store.copy(
            card,
            source_agent=self.agent_id,
            user_scope=user_scope,
        )

    def due_reminders(
        self,
        now_ms: int | None = None,
        *,
        acl_bindings: Any = None,
        scope_key: str | None = None,
        aclBindings: Any = None,
        scopeKey: str | None = None,
    ) -> list[dict[str, Any]]:
        """Return active reminder cards whose due timestamp has passed."""
        acl_bindings = aclBindings if aclBindings is not None else acl_bindings
        scope_key = scopeKey if scopeKey is not None else scope_key
        selector = self._scope_selector(acl_bindings=acl_bindings, scope_key=scope_key)
        now = now_ms or _now_ms()
        due = []
        for row in self._metadata_rows_for_scope(selector):
            metadata = self._metadata_json(row)
            remind_at = int(metadata.get("remindAt") or 0)
            status = str(metadata.get("reminderStatus") or "")
            if remind_at and remind_at <= now and status not in {"acknowledged", "cancelled", "presented"}:
                due.append({
                    "id": row["id"],
                    "text": metadata.get("text") or metadata.get("content") or "",
                    "remindAt": remind_at,
                    "status": status or "pending",
                })
        return due

    def obsidian_candidates(self, limit: int = 100) -> list[dict[str, str]]:
        """Return changed Markdown notes for an explicit bidirectional sync."""
        state_path = self.state_dir / "obsidian-sync.json"
        state = self._read_json(state_path)
        previous = state.get("hashes", {}) if isinstance(state.get("hashes"), dict) else {}
        candidates = []
        if not self.workspace_dir.is_dir():
            return candidates
        for path in sorted(self.workspace_dir.rglob("*.md")):
            relative = path.relative_to(self.workspace_dir)
            if relative.parts[:2] == ("plur1bus", "memories") or ".stversions" in relative.parts:
                continue
            content = path.read_text(encoding="utf-8", errors="replace")
            digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
            if previous.get(str(relative)) == digest:
                continue
            candidates.append({"path": str(relative), "content": content, "sha256": digest})
            if len(candidates) >= max(1, min(limit, 1000)):
                break
        return candidates

    def mark_obsidian_synced(self, candidates: list[dict[str, str]]) -> None:
        """Commit successful Markdown import hashes atomically."""
        state_path = self.state_dir / "obsidian-sync.json"
        state = self._read_json(state_path)
        hashes = dict(state.get("hashes", {})) if isinstance(state.get("hashes"), dict) else {}
        for candidate in candidates:
            hashes[candidate["path"]] = candidate["sha256"]
        self._write_json(state_path, {"updatedAt": _utcnow(), "hashes": hashes})

    def rebuild_indexes(
        self,
        table: Any,
        *,
        acl_bindings: Any = None,
        scope_key: str | None = None,
        aclBindings: Any = None,
        scopeKey: str | None = None,
    ) -> dict[str, Any]:
        """Rebuild model-independent graph link and semantic-lens indexes."""
        acl_bindings = aclBindings if aclBindings is not None else acl_bindings
        scope_key = scopeKey if scopeKey is not None else scope_key
        selector = self._scope_selector(acl_bindings=acl_bindings, scope_key=scope_key)
        edges = [
            edge
            for edge in self._read_jsonl(self.neo_dir / "memory-graph.jsonl")
            if _row_matches_scope(edge, selector)
        ]
        adjacency: dict[str, set[str]] = {}
        for edge in edges:
            source = str(edge.get("source") or "")
            target = str(edge.get("target") or "")
            if not source or not target:
                continue
            adjacency.setdefault(source, set()).add(target)
            if not edge.get("directed"):
                adjacency.setdefault(target, set()).add(source)
        visited = set()
        communities: dict[str, dict[str, Any]] = {}
        memory_to_community: dict[str, str] = {}
        for seed in adjacency:
            if seed in visited:
                continue
            stack = [seed]
            members = []
            while stack and len(members) < 5000:
                current = stack.pop()
                if current in visited:
                    continue
                visited.add(current)
                members.append(current)
                stack.extend(adjacency.get(current, set()) - visited)
            community_id = "c-" + hashlib.sha256("|".join(sorted(members)).encode("utf-8")).hexdigest()[:12]
            communities[community_id] = {"memoryIds": members, "size": len(members)}
            for memory_id in members:
                memory_to_community[memory_id] = community_id
        index_dir = self.workspace_dir / ".plur1bus"
        self._write_json(index_dir / "semantic-lens-index.json", {
            "version": 1,
            "generatedAt": _utcnow(),
            "workspaceId": self.agent_id,
            "scopeKey": selector.scope_key,
            "aclBindings": selector.acl_bindings,
            "memoryToCommunity": memory_to_community,
            "communities": communities,
        })
        self._write_json(index_dir / "link-index.json", {
            "version": "1",
            "generatedAt": _utcnow(),
            "scopeKey": selector.scope_key,
            "aclBindings": selector.acl_bindings,
            "entries": {
                memory_id: {"links": sorted(neighbors)}
                for memory_id, neighbors in adjacency.items()
            },
        })
        ann_status = "not-created"
        try:
            table.create_index(metric="cosine", vector_column_name="vector", replace=True)
            ann_status = "created"
        except Exception as error:
            ann_status = f"failed:{type(error).__name__}"
        result = {
            "graphEdges": len(edges),
            "communities": len(communities),
            "linkedMemories": len(adjacency),
            "annIndex": ann_status,
            "generatedAt": _utcnow(),
        }
        self._write_json(self.state_dir / "index-rebuild.json", result)
        return result

    def run_dreaming(
        self,
        table: Any,
        max_memories: int = 12,
        *,
        acl_bindings: Any = None,
        scope_key: str | None = None,
        aclBindings: Any = None,
        scopeKey: str | None = None,
    ) -> dict[str, Any]:
        """Create a bounded, non-destructive REM dream from active memories."""
        acl_bindings = aclBindings if aclBindings is not None else acl_bindings
        scope_key = scopeKey if scopeKey is not None else scope_key
        selector = self._scope_selector(acl_bindings=acl_bindings, scope_key=scope_key)
        rows = table.search().where(
            selector.where(" AND status = 'active'")
        ).limit(max_memories).to_list()
        rows = self._filter_rows(rows, selector)[:max_memories]
        dream = build_rem_dream(
            rows,
            self.agent_id,
            acl_bindings=selector.acl_bindings,
            scope_key=selector.scope_key,
        )
        self._append_jsonl(self.neo_dir / "dream-diary.jsonl", dream)
        dreams_path = self.workspace_dir / "DREAMS.md"
        dreams_path.parent.mkdir(parents=True, exist_ok=True)
        with dreams_path.open("a", encoding="utf-8") as handle:
            handle.write(f"\n## Dream {_utcnow()}\n\n")
            handle.write(f"{dream['narrative']}\n\n")
            for insight in dream["insights"]:
                handle.write(f"- {insight}\n")
        return dream

    def run_consolidation(
        self,
        table: Any,
        *,
        acl_bindings: Any = None,
        scope_key: str | None = None,
        aclBindings: Any = None,
        scopeKey: str | None = None,
    ) -> dict[str, Any]:
        """Generate a non-destructive duplicate and dynamics maintenance report."""
        acl_bindings = aclBindings if aclBindings is not None else acl_bindings
        scope_key = scopeKey if scopeKey is not None else scope_key
        selector = self._scope_selector(acl_bindings=acl_bindings, scope_key=scope_key)
        rows = table.search().where(selector.where()).limit(100000).to_list()
        rows = self._filter_rows(rows, selector)
        groups: dict[str, list[str]] = {}
        for row in rows:
            digest = hashlib.sha256(_normalized_text(str(row.get("content") or "")).encode("utf-8")).hexdigest()
            groups.setdefault(digest, []).append(str(row.get("id") or ""))
        duplicates = [ids for ids in groups.values() if len(ids) > 1]
        proposals = []
        for memory_ids in duplicates:
            proposal = {
                "id": "merge-" + hashlib.sha256(
                    "|".join(sorted(memory_ids)).encode("utf-8")
                ).hexdigest()[:16],
                "agentId": self.agent_id,
                "memoryIds": memory_ids,
                "status": "pending_review",
                "autoApply": False,
                "createdAt": _utcnow(),
            }
            proposals.append(proposal)
        self._write_json(
            self.state_dir / "merge-proposals.json",
            {"generatedAt": _utcnow(), "proposals": proposals},
        )
        conflict_recommendations = []
        for conflict in self._read_jsonl(
            self.neo_dir / "contradiction-disclosure.jsonl"
        ):
            if not _row_matches_scope(conflict, selector):
                continue
            conflict_recommendations.append({
                "newMemoryId": conflict.get("newMemoryId"),
                "existingMemoryId": conflict.get("existingMemoryId"),
                "score": conflict.get("score"),
                "recommendation": (
                    "apply_via_safe_reconsolidation"
                    if float(conflict.get("score") or 0) >= 0.9
                    else "review_only"
                ),
                "autoApply": False,
            })
        self._write_json(
            self.state_dir / "conflict-recommendations.json",
            {
                "generatedAt": _utcnow(),
                "recommendations": conflict_recommendations,
            },
        )
        dynamics = self.run_dynamics(scope_key=selector.scope_key)
        report = {
            "agentId": self.agent_id,
            "generatedAt": _utcnow(),
            "cardsScanned": len(rows),
            "duplicateGroups": duplicates,
            "mergeProposals": len(proposals),
            "conflictRecommendations": len(conflict_recommendations),
            "dynamics": dynamics,
            "destructiveChanges": False,
        }
        self._write_json(self.state_dir / "consolidation-report.json", report)
        return report

    def run_gc(
        self,
        table: Any,
        now_ms: int | None = None,
        *,
        acl_bindings: Any = None,
        scope_key: str | None = None,
        aclBindings: Any = None,
        scopeKey: str | None = None,
    ) -> dict[str, Any]:
        """Archive expired active or superseded cards through a GC-only scan.

        Recall and shared/vault paths continue using the active-only predicate;
        this separate predicate is the Hermes equivalent of OpenClaw's
        ``scanCollectable`` and intentionally includes superseded rows.
        """
        acl_bindings = aclBindings if aclBindings is not None else acl_bindings
        scope_key = scopeKey if scopeKey is not None else scope_key
        selector = self._scope_selector(acl_bindings=acl_bindings, scope_key=scope_key)
        now = now_ms or _now_ms()
        metadata_by_id = {
            str(row.get("id") or ""): self._metadata_json(row)
            for row in self._metadata_rows_for_scope(selector)
        }
        rows = table.search().where(
            selector.where(" AND (status = 'active' OR status = 'superseded')")
        ).limit(100000).to_list()
        rows = self._filter_rows(rows, selector)
        archived = []
        archive_dir = self.data_dir / "archives" / self.agent_id / "gc"
        for row in rows:
            memory_id = safe_memory_id(str(row.get("id") or ""))
            expires_at = int(
                metadata_by_id.get(memory_id, {}).get("expiresAt") or 0
            )
            if not expires_at or expires_at > now:
                continue
            archive_dir.mkdir(parents=True, exist_ok=True)
            archive_path = archive_dir / f"{memory_id}.json"
            if not archive_path.exists():
                archive_path.write_text(
                    json.dumps(row, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8",
                )
            table.update(
                where=f"id = '{memory_id}' AND {selector.where()}",
                values={"status": "archived"},
            )
            self._append_jsonl(
                self.state_dir / "destructive-operations.jsonl",
                {
                    "operation": "gc-archive-expired",
                    "id": memory_id,
                    "archive": str(archive_path),
                    "createdAt": _utcnow(),
                },
            )
            archived.append(memory_id)
        return {
            "scanned": len(rows),
            "archived": archived,
            "count": len(archived),
            "hardDeleted": 0,
        }

    def run_dynamics(
        self,
        *,
        acl_bindings: Any = None,
        scope_key: str | None = None,
        aclBindings: Any = None,
        scopeKey: str | None = None,
    ) -> dict[str, Any]:
        """Decay strength by half-life while applying explicit feedback signals."""
        acl_bindings = aclBindings if aclBindings is not None else acl_bindings
        scope_key = scopeKey if scopeKey is not None else scope_key
        selector = self._scope_selector(acl_bindings=acl_bindings, scope_key=scope_key)
        feedback = self._read_jsonl(self.workspace_dir / ".adaptive-learning" / "feedback-log.jsonl")
        adjustments: dict[str, float] = {}
        for item in feedback:
            if not _row_matches_scope(item, selector):
                continue
            value = {"useful": 0.1, "irrelevant": -0.1, "incorrect": -0.25}.get(str(item.get("feedback")), 0)
            adjustments[str(item.get("memoryId") or "")] = adjustments.get(str(item.get("memoryId") or ""), 0) + value
        changed = 0
        now = _now_ms()
        table = self._metadata_table()
        if table is None:
            return {"changed": 0}
        all_rows = [dict(row) for row in table.to_arrow().to_pylist()]
        rows = [
            row
            for row in all_rows
            if _row_matches_scope(
                self._metadata_json(row)
                if _row_scope_key(self._metadata_json(row))
                else row,
                selector,
            )
        ]
        for row in rows:
            metadata = self._metadata_json(row)
            half_life = max(1, int(metadata.get("halfLifeDays") or 30))
            last = int(metadata.get("lastDynamicsAt") or metadata.get("updatedAt") or metadata.get("sourceTimestamp") or now)
            elapsed_days = max(0.0, (now - last) / 86_400_000)
            strength = float(metadata.get("memoryStrength") or 1.0)
            strength = max(0.0, min(1.0, strength * math.pow(0.5, elapsed_days / half_life) + adjustments.get(row["id"], 0)))
            metadata["memoryStrength"] = strength
            metadata["lastDynamicsAt"] = now
            row["metadataJson"] = json.dumps(
                metadata,
                ensure_ascii=True,
                sort_keys=True,
                default=str,
            )
            changed += 1
        if rows:
            import lancedb

            database = lancedb.connect(str(self.data_dir / "lancedb" / self.agent_id))
            database.create_table("metadata", data=all_rows, mode="overwrite")
        return {"changed": changed}

    def critical_items(self, status: str | None = "pending_review") -> list[dict[str, Any]]:
        """Return the latest append-only critical review state per memory."""
        latest: dict[str, dict[str, Any]] = {}
        for item in self._read_jsonl(self.state_dir / "critical-push.jsonl"):
            memory_id = str(item.get("id") or "")
            if memory_id:
                latest[memory_id] = item
        values = list(latest.values())
        if status is not None:
            values = [item for item in values if item.get("status") == status]
        return values

    def critical_reference_map(self) -> dict[str, str]:
        """Kürzeste eindeutige Kurzreferenz je ausstehender Critical-Review."""
        pending = self.critical_items("pending_review")
        return assign_short_refs([str(item["id"]) for item in pending])

    def resolve_critical_reference(self, reference: str) -> dict[str, Any]:
        """Löst eine Kurzreferenz (oder vollständige UUID) gegen ausstehende
        Reviews auf. Liefert ``{"ok": True, "id": ...}`` oder ein Fehlerobjekt.
        """
        pending = self.critical_items("pending_review")
        return resolve_short_ref(reference, pending)

    def review_critical_by_reference(self, reference: str, decision: str) -> dict[str, Any]:
        """Accept/Reject über Kurzreferenz oder vollständige UUID."""
        resolved = self.resolve_critical_reference(reference)
        if not resolved["ok"]:
            return {"updated": False, "reason": resolved["error"], "reference": reference}
        return self.review_critical(resolved["id"], decision)

    def speaker_mappings(self) -> dict[str, str]:
        """Return the current agent-local speaker alias mappings."""
        return self._speakers.mappings()

    def set_llm_backend(self, backend: Any) -> None:
        """Attach the runtime-owned internal LLM backend."""
        self._llm_backend = backend

    def _analyze_text(self, text: str) -> dict[str, Any]:
        complete = None
        if self._llm_backend is not None and self._llm_backend.available():
            complete = self._llm_backend.complete_json
        return analyze_text_tiered(
            text,
            self.config,
            complete_json=complete,
        )

    def mood_state(self) -> dict[str, Any]:
        """Return the current persisted mood and temperament."""
        return self._mood.state()

    def set_temperament(self, preset: str) -> dict[str, Any]:
        """Apply a documented temperament preset for this agent."""
        return self._mood.set_preset(preset)

    def proactive_check(self) -> dict[str, Any]:
        """Run pattern detection and enqueue a governed nudge when eligible."""
        return self._proactive.proactive_check()

    def run_afterthought(self) -> dict[str, Any]:
        """Run the governed 30-120 minute afterthought workflow."""
        return self._proactive.afterthought()

    def run_meta_reflection(self) -> dict[str, Any]:
        """Compute feedback-derived precision, recall, F1, and coverage state."""
        return self._proactive.meta_reflect()

    def proactive_messages(self) -> list[dict[str, Any]]:
        """Return pending proactive messages for adapter delivery."""
        return self._proactive.pending_messages()

    def mark_proactive_sent(self, message_ids: list[str]) -> None:
        """Mark successfully delivered proactive messages."""
        self._proactive.mark_sent(message_ids)

    def rebuild_code_index(self) -> dict[str, Any]:
        """Rebuild the bounded source index for this agent workspace."""
        return rebuild_code_index(self.workspace_dir)

    def query_code(self, query: str, limit: int = 20) -> list[dict[str, Any]]:
        """Query the agent workspace source index."""
        return query_code_index(self.workspace_dir, query, limit)

    def set_speaker_mapping(self, alias: str, person: str) -> dict[str, str]:
        """Persist one agent-local speaker alias mapping."""
        return self._speakers.set_mapping(alias, person)

    def maintain_obsidian(
        self,
        *,
        acl_bindings: Any = None,
        scope_key: str | None = None,
        aclBindings: Any = None,
        scopeKey: str | None = None,
    ) -> dict[str, Any]:
        """Regenerate managed Obsidian dashboards and review views."""
        acl_bindings = aclBindings if aclBindings is not None else acl_bindings
        scope_key = scopeKey if scopeKey is not None else scope_key
        selector = self._scope_selector(acl_bindings=acl_bindings, scope_key=scope_key)
        return generate_obsidian_control_room(
            self.workspace_dir,
            self.agent_id,
            metadata_rows=self._metadata_rows_for_scope(selector),
            episodes=[
                row for row in self._read_jsonl(self.neo_dir / "episodes.jsonl")
                if _row_matches_scope(row, selector)
            ],
            dreams=[
                row for row in self._read_jsonl(self.neo_dir / "dream-diary.jsonl")
                if _row_matches_scope(row, selector)
            ],
            contradictions=[
                row for row in self._read_jsonl(self.neo_dir / "contradiction-disclosure.jsonl")
                if _row_matches_scope(row, selector)
            ],
            open_threads=[
                row for row in self._read_jsonl(self.neo_dir / "open-threads.jsonl")
                if _row_matches_scope(row, selector)
            ],
        )

    def review_critical(self, memory_id: str, decision: str) -> dict[str, Any]:
        """Accept or reject a pending critical-memory proposal."""
        memory_id = safe_memory_id(memory_id)
        if decision not in {"accept", "reject"}:
            raise ValueError("decision must be accept or reject")
        pending = {
            item["id"]: item for item in self.critical_items("pending_review")
        }
        if memory_id not in pending:
            return {"updated": False, "reason": "not-pending", "id": memory_id}
        transition = {
            **pending[memory_id],
            "status": "accepted" if decision == "accept" else "rejected",
            "reviewedAt": _utcnow(),
        }
        self._append_jsonl(self.state_dir / "critical-push.jsonl", transition)
        return {"updated": True, **transition}

    def mark_criticals_notified(self, memory_ids: list[str]) -> dict[str, Any]:
        """Record successful delivery while keeping proposals pending for review."""
        pending = {
            item["id"]: item for item in self.critical_items("pending_review")
        }
        notified = []
        for raw_id in memory_ids:
            memory_id = safe_memory_id(raw_id)
            if memory_id not in pending:
                continue
            transition = {
                **pending[memory_id],
                "status": "pending_review",
                "notifiedAt": _utcnow(),
            }
            self._append_jsonl(self.state_dir / "critical-push.jsonl", transition)
            notified.append(memory_id)
        return {"notified": notified, "count": len(notified)}

    def auto_accept_stale_criticals(self, max_age_ms: int = 604_800_000) -> dict[str, Any]:
        """Accept critical proposals left pending beyond the configured age."""
        now = datetime.now(timezone.utc)
        accepted = []
        for item in self.critical_items("pending_review"):
            try:
                created = datetime.fromisoformat(str(item.get("createdAt") or ""))
            except ValueError:
                continue
            if created.tzinfo is None:
                created = created.replace(tzinfo=timezone.utc)
            if (now - created).total_seconds() * 1000 >= max_age_ms:
                result = self.review_critical(str(item["id"]), "accept")
                if result["updated"]:
                    accepted.append(str(item["id"]))
        return {"accepted": accepted, "count": len(accepted)}

    def update_reminder(self, memory_id: str, action: str) -> dict[str, Any]:
        """Acknowledge or cancel a reminder while preserving all card metadata."""
        memory_id = safe_memory_id(memory_id)
        if action not in {"acknowledge", "cancel", "present"}:
            raise ValueError("action must be acknowledge, cancel, or present")
        table = self._metadata_table()
        if table is None:
            return {"updated": False, "reason": "metadata-table-unavailable"}
        matches = [
            dict(row)
            for row in self._metadata_rows()
            if str(row.get("id") or "") == memory_id
        ]
        if not matches:
            return {"updated": False, "reason": "not-found", "id": memory_id}
        timestamp = _now_ms()
        for row in matches:
            metadata = self._metadata_json(row)
            status_by_action = {
                "acknowledge": "acknowledged",
                "cancel": "cancelled",
                "present": "presented",
            }
            timestamp_by_action = {
                "acknowledge": "acknowledgedAt",
                "cancel": "cancelledAt",
                "present": "remindedAt",
            }
            metadata["reminderStatus"] = status_by_action[action]
            metadata[timestamp_by_action[action]] = timestamp
            row["metadataJson"] = json.dumps(
                metadata, ensure_ascii=False, sort_keys=True
            )
        table.delete(f"id = '{memory_id}'")
        table.add(matches)
        event = {
            "id": memory_id,
            "agentId": self.agent_id,
            "action": action,
            "createdAt": _utcnow(),
        }
        self._append_jsonl(self.neo_dir / "reminder-dispatch-ledger.jsonl", event)
        return {"updated": True, **event}

    def status(self) -> dict[str, Any]:
        """Return feature-store health and imported artifact counts."""
        return {
            "agentId": self.agent_id,
            "graphEdges": len(self._read_jsonl(self.neo_dir / "memory-graph.jsonl")),
            "dreams": len(self._read_jsonl(self.neo_dir / "dream-diary.jsonl")),
            "episodes": len(self._read_jsonl(self.neo_dir / "episodes.jsonl")),
            "feedback": len(self._read_jsonl(self.workspace_dir / ".adaptive-learning" / "feedback-log.jsonl")),
            "dueReminders": len(self.due_reminders()),
            "pendingCriticals": len(self.critical_items()),
            "obsidianMirror": str(self.workspace_dir / "plur1bus" / "memories"),
        }

    def _metadata_for(self, record: dict[str, Any]) -> dict[str, Any]:
        content = str(record.get("content") or "")
        is_correction = str(record.get("sourceRole") or "") == "correction"
        emotion, intensity = self._emotion(content)
        return {
            "text": content,
            "summary": content[:500],
            "importance": self._importance(content, str(record.get("sourceRole") or "")),
            "category": "conversation",
            "scope": str(record.get("scopeType") or "agent-private"),
            "scopeKey": str(record.get("scopeKey") or ""),
            "aclBindings": record.get("aclBindings") or {},
            "type": str(record.get("type") or "observation"),
            "confirmed": str(record.get("sourceRole")) == "user",
            "emotionalDominant": emotion,
            "emotionalIntensity": intensity,
            "moodContextAtCapture": self._mood.state(),
            "retrievalCount": 1 if is_correction else 0,
            "lastRetrievedAt": _now_ms() if is_correction else 0,
            "memoryStrength": 1.15 if is_correction else 1.0,
            "halfLifeDays": 180 if str(record.get("sourceRole")) == "user" else 30,
            "lastDynamicsAt": _now_ms(),
            "neverForget": False,
            "coreMemoryScore": 0.0,
            "status": str(record.get("status") or "active"),
            "memoryKind": "memory",
            "reminderStatus": "",
            "remindAt": 0,
        }

    def _store_metadata(self, record: dict[str, Any]) -> None:
        agent_dir = self.data_dir / "lancedb" / self.agent_id
        try:
            import lancedb
        except ImportError:
            return
        database = lancedb.connect(str(agent_dir))
        metadata = self._metadata_for(record)
        row = {
            "id": record["id"],
            "agentId": self.agent_id,
            "sourceAgent": self.agent_id,
            "originalId": record["id"],
            "legacyStatus": "",
            "metadataJson": json.dumps(metadata, ensure_ascii=False, sort_keys=True),
        }
        if "metadata" in database.table_names():
            database.open_table("metadata").add([row])
        else:
            database.create_table("metadata", data=[row])

    def _build_graph_edges(self, record: dict[str, Any], table: Any) -> None:
        selector = self._scope_selector(record=record)
        try:
            neighbors = table.search(record["vector"]).where(
                selector.where(" AND status = 'active'")
            ).limit(4).to_list()
            neighbors = self._filter_rows(neighbors, selector)
        except Exception as error:
            self._append_jsonl(self.state_dir / "domain-errors.jsonl", {
                "operation": "graph-neighbor-search",
                "errorType": type(error).__name__,
                "error": str(error),
                "createdAt": _utcnow(),
            })
            return
        for neighbor in neighbors:
            target = str(neighbor.get("id") or "")
            if not target or target == record["id"]:
                continue
            contradiction = contradiction_score(
                str(record.get("content") or ""),
                str(neighbor.get("content") or ""),
            )
            if contradiction:
                self._append_jsonl(self.neo_dir / "memory-graph.jsonl", {
                    "source": record["id"],
                    "target": target,
                    "agentId": self.agent_id,
                    "scopeKey": selector.scope_key,
                    "aclBindings": selector.acl_bindings,
                    "type": "contradiction",
                    "strength": contradiction,
                    "directed": False,
                    "createdAt": _utcnow(),
                    "updatedAt": _utcnow(),
                    "lastReinforcedAt": _utcnow(),
                    "observations": 1,
                    "algorithmVersion": "hermes-1.0",
                })
                self._append_jsonl(self.neo_dir / "contradiction-disclosure.jsonl", {
                    "id": str(uuid.uuid4()),
                    "agentId": self.agent_id,
                    "scopeKey": selector.scope_key,
                    "aclBindings": selector.acl_bindings,
                    "newMemoryId": record["id"],
                    "existingMemoryId": target,
                    "score": contradiction,
                    "status": "requires_review",
                    "createdAt": _utcnow(),
                })
            distance = float(neighbor.get("_distance", 1.0))
            strength = max(0.0, min(1.0, 1.0 - distance))
            if strength < 0.5:
                continue
            self._append_jsonl(self.neo_dir / "memory-graph.jsonl", {
                "source": record["id"],
                "target": target,
                "agentId": self.agent_id,
                "scopeKey": selector.scope_key,
                "aclBindings": selector.acl_bindings,
                "type": "semantic",
                "strength": strength,
                "directed": False,
                "createdAt": _utcnow(),
                "updatedAt": _utcnow(),
                "lastReinforcedAt": _utcnow(),
                "observations": 1,
                "algorithmVersion": "hermes-1.0",
            })
            self._update_graph_links(str(record["id"]), target)

    def _write_obsidian_note(self, record: dict[str, Any]) -> None:
        note = self.workspace_dir / "plur1bus" / "memories" / f"{record['id']}.md"
        note.parent.mkdir(parents=True, exist_ok=True)
        content = str(record.get("content") or "")
        text = (
            "---\n"
            f"id: {record['id']}\n"
            f"agent: {self.agent_id}\n"
            f"status: {record.get('status', 'active')}\n"
            f"type: {record.get('type', 'observation')}\n"
            f"created: {record.get('createdAt', _utcnow())}\n"
            "tags:\n"
            "  - plur1bus/memory\n"
            f"  - plur1bus/agent/{self.agent_id}\n"
            "---\n\n"
            f"{content}\n\n"
            '<section id="graph-links">\n<!-- PLUR1BUS managed graph links -->\n</section>\n'
        )
        note.write_text(text, encoding="utf-8")

    def _update_graph_links(self, source: str, target: str) -> None:
        for memory_id, linked_id in ((source, target), (target, source)):
            note = self.workspace_dir / "plur1bus" / "memories" / f"{memory_id}.md"
            if not note.is_file():
                continue
            text = note.read_text(encoding="utf-8", errors="replace")
            match = re.search(r'<section id="graph-links">.*?</section>', text, flags=re.DOTALL)
            links = set(re.findall(r"\[\[plur1bus/memories/([^\]|]+)", match.group(0) if match else ""))
            links.add(linked_id)
            block = '<section id="graph-links">\n' + "\n".join(
                f"- [[plur1bus/memories/{value}|{value}]]" for value in sorted(links)
            ) + "\n</section>"
            if match:
                text = text[:match.start()] + block + text[match.end():]
            else:
                text += "\n" + block + "\n"
            note.write_text(text, encoding="utf-8")

    def _graph_neighbor_ids(
        self,
        seeds: set[str],
        *,
        acl_bindings: Any = None,
        scope_key: str | None = None,
    ) -> set[str]:
        selector = self._scope_selector(acl_bindings=acl_bindings, scope_key=scope_key)
        neighbors = set()
        for edge in self._read_jsonl(self.neo_dir / "memory-graph.jsonl"):
            if not _row_matches_scope(edge, selector):
                continue
            if float(edge.get("strength") or 0) < 0.5:
                continue
            source, target = str(edge.get("source") or ""), str(edge.get("target") or "")
            if source in seeds:
                neighbors.add(target)
            if not edge.get("directed") and target in seeds:
                neighbors.add(source)
        return neighbors

    def _semantic_lens_ids(
        self,
        seeds: set[str],
        *,
        acl_bindings: Any = None,
        scope_key: str | None = None,
    ) -> set[str]:
        selector = self._scope_selector(acl_bindings=acl_bindings, scope_key=scope_key)
        index = self._read_json(self.workspace_dir / ".plur1bus" / "semantic-lens-index.json")
        index_scope = str(index.get("scopeKey") or "")
        if (
            index_scope not in {selector.scope_key, legacy_agent_private_scope_key()}
            and not (selector.scope_type == "agent-private" and not index_scope)
        ):
            return set()
        memory_to_community = index.get("memoryToCommunity", {})
        communities = index.get("communities", {})
        community_ids = {memory_to_community.get(seed) for seed in seeds if memory_to_community.get(seed)}
        candidates = set()
        for community_id in community_ids:
            community = communities.get(community_id, {})
            for key in ("members", "memoryIds", "ids"):
                values = community.get(key, []) if isinstance(community, dict) else []
                if isinstance(values, list):
                    candidates.update(str(value) for value in values)
        return candidates

    def _reactivation_ids(
        self,
        seeds: set[str],
        *,
        acl_bindings: Any = None,
        scope_key: str | None = None,
    ) -> set[str]:
        selector = self._scope_selector(acl_bindings=acl_bindings, scope_key=scope_key)
        index = self._read_json(self.workspace_dir / ".plur1bus" / "link-index.json")
        index_scope = str(index.get("scopeKey") or "")
        if (
            index_scope not in {selector.scope_key, legacy_agent_private_scope_key()}
            and not (selector.scope_type == "agent-private" and not index_scope)
        ):
            return set()
        entries = index.get("entries", {})
        candidates = set()
        for seed in seeds:
            entry = entries.get(seed, {}) if isinstance(entries, dict) else {}
            if isinstance(entry, dict) and str(entry.get("scopeKey") or "") in {"", selector.scope_key, legacy_agent_private_scope_key()}:
                for key in ("links", "targets", "memoryIds"):
                    values = entry.get(key, [])
                    if isinstance(values, list):
                        for value in values[:3]:
                            if isinstance(value, Mapping):
                                if _row_matches_scope(value, selector):
                                    candidate = str(value.get("id") or value.get("memoryId") or "")
                                    if candidate:
                                        candidates.add(candidate)
                            else:
                                candidates.add(str(value))
        return candidates

    def _hydrate_ids(
        self,
        table: Any,
        ids: set[str],
        limit: int,
        *,
        acl_bindings: Any = None,
        scope_key: str | None = None,
    ) -> list[dict[str, Any]]:
        if not ids or limit <= 0:
            return []
        selector = self._scope_selector(acl_bindings=acl_bindings, scope_key=scope_key)
        valid = []
        for value in ids:
            try:
                valid.append(safe_memory_id(value))
            except Exception:
                continue
        if not valid:
            return []
        where = " OR ".join(f"id = '{value}'" for value in valid[:50])
        try:
            rows = table.search().where(
                f"({where}) AND {selector.where()} AND status = 'active'"
            ).limit(limit).to_list()
            return self._filter_rows(rows, selector)[:limit]
        except Exception:
            return []

    def _metadata_table(self) -> Any | None:
        try:
            import lancedb
            database = lancedb.connect(str(self.data_dir / "lancedb" / self.agent_id))
            return database.open_table("metadata") if "metadata" in database.table_names() else None
        except Exception:
            return None

    def _metadata_rows(self) -> list[dict[str, Any]]:
        table = self._metadata_table()
        return table.to_arrow().to_pylist() if table is not None else []

    @staticmethod
    def _metadata_json(row: dict[str, Any]) -> dict[str, Any]:
        try:
            loaded = json.loads(str(row.get("metadataJson") or "{}"))
        except json.JSONDecodeError:
            return {}
        return loaded if isinstance(loaded, dict) else {}

    @staticmethod
    def _importance(content: str, role: str) -> float:
        score = 0.7 if role == "user" else 0.5
        lower = content.lower()
        if any(token in lower for token in ("remember", "merke", "wichtig", "never forget", "nie vergessen")):
            score += 0.2
        return min(1.0, score)

    @staticmethod
    def _emotion(content: str) -> tuple[str, float]:
        lower = content.lower()
        labels = {
            "joy": ("danke", "freue", "great", "super"),
            "anger": ("wut", "sauer", "ärger", "angry"),
            "fear": ("angst", "sorge", "fear"),
            "sadness": ("traurig", "sad"),
            "trust": ("vertraue", "trust"),
        }
        for label, terms in labels.items():
            if any(term in lower for term in terms):
                return label, 0.6
        return "neutral", 0.0

    def _append_jsonl(self, path: Path, value: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        with self._lock, path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(value, ensure_ascii=False, sort_keys=True, default=str) + "\n")

    def audit_mutation(self, entry: dict[str, Any]) -> None:
        """Append-only Mutations-Audit (destructive-operations.jsonl)."""
        self._append_jsonl(
            self.state_dir / "destructive-operations.jsonl",
            {**entry, "timestamp": _utcnow()},
        )

    @staticmethod
    def _read_jsonl(path: Path) -> list[dict[str, Any]]:
        if not path.is_file():
            return []
        records = []
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            try:
                loaded = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(loaded, dict):
                records.append(loaded)
        return records

    @staticmethod
    def _read_json(path: Path) -> dict[str, Any]:
        if not path.is_file():
            return {}
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        return loaded if isinstance(loaded, dict) else {}

    @staticmethod
    def _write_json(path: Path, value: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True, default=str) + "\n", encoding="utf-8")
        temporary.replace(path)
