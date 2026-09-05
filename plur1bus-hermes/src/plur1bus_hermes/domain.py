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
from .critical import CRITICAL_TYPES, NON_CRITICAL_TYPE, classify_critical, is_confirmed
from .critical_review import (
    assign_short_refs,
    decode_critical_cursor,
    encode_critical_cursor,
    resolve_short_ref,
)
from .dreaming import build_rem_dream
from .obsidian_maintenance import generate_obsidian_control_room
from .mood import MoodEngine
from .namespaces import (
    ScopeBinding,
    binding_from_scope,
    canonical_scope_binding,
    legacy_agent_private_scope_key,
    resolve_namespace_routes,
    scope_where_clause,
)
from .proactive import ProactiveEngine
from .speakers import SpeakerMappingStore
from .shared_pools import SharedPoolStore, SharedPrincipal
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

    @staticmethod
    def _scope_storage_key(selector: _ScopeSelector) -> str:
        """Return a filesystem-safe owner key, including for opaque test/legacy scopes."""
        if re.fullmatch(r"[0-9a-f]{64}", selector.scope_key):
            return selector.scope_key
        return hashlib.sha256(
            f"{selector.scope_type}:{selector.scope_key}".encode("utf-8")
        ).hexdigest()

    def _scope_state_dir(self, selector: _ScopeSelector) -> Path:
        if selector.scope_type == "agent-private":
            return self.state_dir
        return self.state_dir / "scopes" / self._scope_storage_key(selector)

    def _scope_neo_dir(self, selector: _ScopeSelector) -> Path:
        if selector.scope_type == "agent-private":
            return self.neo_dir
        return self.neo_dir / "scopes" / self._scope_storage_key(selector)

    def _scope_workspace_dir(self, selector: _ScopeSelector) -> Path:
        if selector.scope_type == "agent-private":
            return self.workspace_dir
        return self.workspace_dir / ".plur1bus-scopes" / self._scope_storage_key(selector)

    def _scoped_jsonl(
        self,
        root: Path,
        scoped_root: Path,
        name: str,
        selector: _ScopeSelector,
    ) -> list[dict[str, Any]]:
        """Read the owner partition plus filtered legacy rows for compatibility."""
        rows = self._read_jsonl(scoped_root / name)
        if scoped_root != root:
            rows.extend(
                row
                for row in self._read_jsonl(root / name)
                if _row_matches_scope(row, selector)
            )
        return rows

    def _job_page(
        self,
        table: Any,
        selector: _ScopeSelector,
        *,
        job: str,
        where_suffix: str,
        page_size: int,
        mutates_predicate: bool = False,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        """Read one durable owner-bound page and advance only after a clean query."""
        bounded_size = max(1, min(int(page_size), 100_000))
        cursor_path = self._scope_state_dir(selector) / "job-cursors" / f"{job}.json"
        state: dict[str, Any] = {}
        if cursor_path.is_file():
            try:
                loaded = json.loads(cursor_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as error:
                raise RuntimeError(f"{job} cursor is unreadable: {error}") from error
            if not isinstance(loaded, dict):
                raise RuntimeError(f"{job} cursor is not an object")
            state = loaded
        try:
            offset = 0 if mutates_predicate else int(state.get("nextOffset") or 0)
        except (TypeError, ValueError) as error:
            raise RuntimeError(f"{job} cursor offset is invalid") from error
        if offset < 0:
            raise RuntimeError(f"{job} cursor offset is invalid")
        query = table.search().where(selector.where(where_suffix))
        if offset:
            offset_method = getattr(query, "offset", None)
            if not callable(offset_method):
                raise RuntimeError(f"{job} query does not support durable pagination")
            query = offset_method(offset)
        raw = [dict(row) for row in query.limit(bounded_size + 1).to_list()]
        has_more = len(raw) > bounded_size
        selected_raw = raw[:bounded_size]
        rows = self._filter_rows(selected_raw, selector)
        if mutates_predicate or not has_more:
            next_offset = 0
        else:
            next_offset = offset + len(selected_raw)
        return rows, {
            "selected": len(rows),
            "complete": not has_more,
            "truncated": has_more,
            "nextCursor": (
                "continue" if mutates_predicate and has_more else next_offset or None
            ),
            "offset": offset,
            "cursorPath": cursor_path,
            "cursorState": {
                "schemaVersion": 1,
                "agentId": selector.agent_id,
                "scopeKey": selector.scope_key,
                "job": job,
                "nextOffset": next_offset,
                "complete": not has_more,
                "updatedAt": _utcnow(),
            },
        }

    def _commit_job_page(self, page: Mapping[str, Any]) -> None:
        """Advance a durable cursor only after the page side effects succeeded."""
        path = page.get("cursorPath")
        state = page.get("cursorState")
        if not isinstance(path, Path) or not isinstance(state, Mapping):
            raise RuntimeError("job page is missing its durable cursor state")
        self._write_json(path, dict(state))

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
        neo_dir = self._scope_neo_dir(selector)
        now = _utcnow()
        turn_ids = []
        for index, (role, content) in enumerate((("user", user), ("assistant", assistant))):
            text = str(content or "").strip()
            if not text:
                continue
            analysis = analyze_text(text)
            turn_id = str(uuid.uuid4())
            turn_ids.append(turn_id)
            self._append_jsonl(neo_dir / "turn-journal.jsonl", {
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
                    "scope": selector.scope_type,
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
            self._append_jsonl(neo_dir / "episodes.jsonl", {
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
            self._append_jsonl(neo_dir / "emotional-state.jsonl", {
                "agentId": self.agent_id,
                "scopeKey": selector.scope_key,
                "aclBindings": selector.acl_bindings,
                "sessionId": session_id,
                "createdAt": now,
                **analysis["emotion"],
            })
            for thread in extract_open_threads(user):
                self._append_jsonl(neo_dir / "open-threads.jsonl", {
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
        importance: float | None = None,
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
        neo_dir = self._scope_neo_dir(selector)
        state_dir = self._scope_state_dir(selector)
        analysis = self._analyze_text(str(record.get("content") or ""))
        self._append_jsonl(neo_dir / "memory-cognition.jsonl", {
            "id": record["id"],
            "agentId": self.agent_id,
            "scopeKey": selector.scope_key,
            "aclBindings": selector.acl_bindings,
            "createdAt": _utcnow(),
            **analysis,
        })
        self._store_metadata(record, importance=importance)
        self._write_obsidian_note(record)
        self._build_graph_edges(record, table)
        metadata = self._metadata_for(record, importance=importance)
        source_role = str(record.get("sourceRole") or "")
        critical = classify_critical(
            str(record.get("content") or ""),
            metadata,
            source_role=source_role,
        )
        classifications = self._read_jsonl(
            state_dir / "critical-classification.jsonl"
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
            for item in self._read_jsonl(state_dir / "critical-push.jsonl")
        )
        classification = {
            "id": record["id"],
            "agentId": self.agent_id,
            "scopeKey": selector.scope_key,
            "aclBindings": selector.acl_bindings,
            **critical,
            "classifiedAt": _utcnow(),
        }
        self._append_jsonl(
            state_dir / "critical-classification.jsonl",
            classification,
        )
        if critical["eligible"] and pushed_today < max_per_day:
            self._append_jsonl(state_dir / "critical-push.jsonl", {
                "id": record["id"],
                "agentId": self.agent_id,
                "scopeKey": selector.scope_key,
                "aclBindings": selector.acl_bindings,
                "importance": critical["importance"],
                "reason": critical["reason"],
                "sourceRole": source_role,
                "contentSuppressed": critical["suppressContent"],
                "status": "pending_review",
                "createdAt": _utcnow(),
            })
        elif critical["eligible"]:
            self._append_jsonl(state_dir / "critical-push.jsonl", {
                "id": record["id"],
                "agentId": self.agent_id,
                "scopeKey": selector.scope_key,
                "aclBindings": selector.acl_bindings,
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
        neo_dir = self._scope_neo_dir(selector)
        contradictions = [
            item
            for item in self._scoped_jsonl(
                self.neo_dir,
                neo_dir,
                "contradiction-disclosure.jsonl",
                selector,
            )
            if _row_matches_scope(item, selector)
            and (str(item.get("newMemoryId") or "") in recalled_ids
            or str(item.get("existingMemoryId") or "") in recalled_ids
            )
        ][-3:]
        open_threads = []
        if analysis["continuationSignal"] or analysis["question"]:
            latest: dict[str, dict[str, Any]] = {}
            for item in self._scoped_jsonl(
                self.neo_dir,
                neo_dir,
                "open-threads.jsonl",
                selector,
            ):
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
        candidate_ids = self._graph_neighbor_ids(
            seen, acl_bindings=selector.acl_bindings
        )
        candidate_ids.update(
            self._semantic_lens_ids(seen, acl_bindings=selector.acl_bindings)
        )
        now = _now_ms()
        if self._last_recall_ms and now - self._last_recall_ms >= 45 * 60 * 1000:
            candidate_ids.update(
                self._reactivation_ids(seen, acl_bindings=selector.acl_bindings)
            )
        self._last_recall_ms = now
        hydrated = self._hydrate_ids(
            table,
            candidate_ids - seen,
            max(0, limit - len(rows)),
            acl_bindings=selector.acl_bindings,
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
        workspace_dir = self._scope_workspace_dir(selector)
        self._append_jsonl(
            workspace_dir / ".adaptive-learning" / "feedback-log.jsonl",
            entry,
        )
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

    def obsidian_candidates(
        self,
        limit: int = 100,
        *,
        acl_bindings: Any = None,
        scope_key: str | None = None,
        aclBindings: Any = None,
        scopeKey: str | None = None,
    ) -> list[dict[str, str]]:
        """Return changed Markdown notes for an explicit bidirectional sync."""
        acl_bindings = aclBindings if aclBindings is not None else acl_bindings
        scope_key = scopeKey if scopeKey is not None else scope_key
        selector = self._scope_selector(acl_bindings=acl_bindings, scope_key=scope_key)
        state_path = self._scope_state_dir(selector) / "obsidian-sync.json"
        workspace_dir = self._scope_workspace_dir(selector)
        state = self._read_json(state_path)
        previous = state.get("hashes", {}) if isinstance(state.get("hashes"), dict) else {}
        candidates = []
        if not workspace_dir.is_dir():
            return candidates
        for path in sorted(workspace_dir.rglob("*.md")):
            relative = path.relative_to(workspace_dir)
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

    def mark_obsidian_synced(
        self,
        candidates: list[dict[str, str]],
        *,
        acl_bindings: Any = None,
        scope_key: str | None = None,
        aclBindings: Any = None,
        scopeKey: str | None = None,
    ) -> None:
        """Commit successful Markdown import hashes atomically."""
        acl_bindings = aclBindings if aclBindings is not None else acl_bindings
        scope_key = scopeKey if scopeKey is not None else scope_key
        selector = self._scope_selector(acl_bindings=acl_bindings, scope_key=scope_key)
        state_path = self._scope_state_dir(selector) / "obsidian-sync.json"
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
        neo_dir = self._scope_neo_dir(selector)
        workspace_dir = self._scope_workspace_dir(selector)
        state_dir = self._scope_state_dir(selector)
        edges = [
            edge
            for edge in self._scoped_jsonl(
                self.neo_dir,
                neo_dir,
                "memory-graph.jsonl",
                selector,
            )
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
        index_dir = workspace_dir / ".plur1bus"
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
        self._write_json(state_dir / "index-rebuild.json", result)
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
        rows, page = self._job_page(
            table,
            selector,
            job="rem-dream",
            where_suffix=" AND status = 'active'",
            page_size=max_memories,
        )
        dream = build_rem_dream(
            rows,
            self.agent_id,
            acl_bindings=selector.acl_bindings,
            scope_key=selector.scope_key,
        )
        # Derived-record visibility stamp (upstream 7.4.0): every new dream
        # record carries an unambiguous scope/owner binding next to its
        # physical scope partition and aclBindings. Readers stay bound to
        # their own selector scope; unstamped legacy rows remain own-agent only.
        dream["visibility"] = {
            "scope": selector.scope_type,
            "agentId": self.agent_id,
            "workspaceIdentity": str(selector.acl_bindings.get("workspaceIdentity") or ""),
            "ownerUserId": str(selector.acl_bindings.get("userId") or ""),
        }
        dream.update({
            "selected": page["selected"],
            "planned": 1 if rows else 0,
            "persisted": 0,
            "executed": 0,
            "complete": page["complete"],
            "truncated": page["truncated"],
            "nextCursor": page["nextCursor"],
        })
        neo_dir = self._scope_neo_dir(selector)
        workspace_dir = self._scope_workspace_dir(selector)
        if not rows:
            self._commit_job_page(page)
            return dream
        self._append_jsonl(neo_dir / "dream-diary.jsonl", dream)
        dreams_path = workspace_dir / "DREAMS.md"
        dreams_path.parent.mkdir(parents=True, exist_ok=True)
        with dreams_path.open("a", encoding="utf-8") as handle:
            handle.write(f"\n## Dream {_utcnow()}\n\n")
            handle.write(f"{dream['narrative']}\n\n")
            for insight in dream["insights"]:
                handle.write(f"- {insight}\n")
        dream["persisted"] = 1
        dream["executed"] = 1
        self._commit_job_page(page)
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
        page_size = int(
            (self.config.get("maintenance") or {}).get(
                "consolidationPageSize", 10_000
            )
        )
        rows, page = self._job_page(
            table,
            selector,
            job="consolidation",
            where_suffix="",
            page_size=page_size,
        )
        state_dir = self._scope_state_dir(selector)
        neo_dir = self._scope_neo_dir(selector)
        accumulator_path = state_dir / "job-cursors" / "consolidation-accumulator.json"
        groups: dict[str, list[str]] = {}
        scanned_before = 0
        if page["offset"]:
            accumulator = self._read_json(accumulator_path)
            if not accumulator or not isinstance(accumulator.get("groups"), dict):
                raise RuntimeError("consolidation accumulator is missing or invalid")
            groups = {
                str(digest): [str(value) for value in values]
                for digest, values in accumulator["groups"].items()
                if isinstance(values, list)
            }
            scanned_before = int(accumulator.get("cardsScanned") or 0)
        for row in rows:
            digest = hashlib.sha256(_normalized_text(str(row.get("content") or "")).encode("utf-8")).hexdigest()
            groups.setdefault(digest, []).append(str(row.get("id") or ""))
        cards_scanned = scanned_before + len(rows)
        if not page["complete"]:
            self._write_json(
                accumulator_path,
                {
                    "agentId": self.agent_id,
                    "scopeKey": selector.scope_key,
                    "cardsScanned": cards_scanned,
                    "groups": groups,
                    "updatedAt": _utcnow(),
                },
            )
            report = {
                "agentId": self.agent_id,
                "generatedAt": _utcnow(),
                "cardsScanned": cards_scanned,
                "selected": len(rows),
                "planned": 0,
                "persisted": 1,
                "executed": 0,
                "complete": False,
                "truncated": True,
                "nextCursor": page["nextCursor"],
                "destructiveChanges": False,
            }
            self._write_json(state_dir / "consolidation-report.json", report)
            self._commit_job_page(page)
            return report
        duplicates = [ids for ids in groups.values() if len(ids) > 1]
        proposals = []
        for memory_ids in duplicates:
            proposal = {
                "id": "merge-" + hashlib.sha256(
                    "|".join(sorted(memory_ids)).encode("utf-8")
                ).hexdigest()[:16],
                "agentId": self.agent_id,
                "scopeKey": selector.scope_key,
                "aclBindings": selector.acl_bindings,
                "memoryIds": memory_ids,
                "status": "pending_review",
                "autoApply": False,
                "createdAt": _utcnow(),
            }
            proposals.append(proposal)
        self._write_json(
            state_dir / "merge-proposals.json",
            {"generatedAt": _utcnow(), "proposals": proposals},
        )
        conflict_recommendations = []
        for conflict in self._scoped_jsonl(
            self.neo_dir,
            neo_dir,
            "contradiction-disclosure.jsonl",
            selector,
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
            state_dir / "conflict-recommendations.json",
            {
                "generatedAt": _utcnow(),
                "recommendations": conflict_recommendations,
            },
        )
        dynamics = self.run_dynamics(acl_bindings=selector.acl_bindings)
        report = {
            "agentId": self.agent_id,
            "generatedAt": _utcnow(),
            "cardsScanned": cards_scanned,
            "duplicateGroups": duplicates,
            "mergeProposals": len(proposals),
            "conflictRecommendations": len(conflict_recommendations),
            "dynamics": dynamics,
            "selected": len(rows),
            "planned": len(proposals) + len(conflict_recommendations),
            "persisted": 3,
            "executed": 0,
            "complete": True,
            "truncated": False,
            "nextCursor": None,
            "destructiveChanges": False,
        }
        self._write_json(state_dir / "consolidation-report.json", report)
        self._commit_job_page(page)
        self._write_json(accumulator_path, {})
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
        page_size = int(
            (self.config.get("maintenance") or {}).get("gcPageSize", 10_000)
        )
        rows, page = self._job_page(
            table,
            selector,
            job="gc",
            where_suffix=" AND (status = 'active' OR status = 'superseded')",
            page_size=page_size,
            mutates_predicate=True,
        )
        archived = []
        planned = 0
        from .tombstone import archive_card_atomically, archive_path_for

        for row in rows:
            memory_id = safe_memory_id(str(row.get("id") or ""))
            expires_at = int(
                metadata_by_id.get(memory_id, {}).get("expiresAt") or 0
            )
            if not expires_at or expires_at > now:
                continue
            planned += 1
            archive_path = archive_path_for(
                self.data_dir,
                self.agent_id,
                selector.scope_key,
                memory_id,
            )
            archive_card_atomically(archive_path, row)
            audit_base = {
                "operation": "gc-archive-expired",
                "id": memory_id,
                "agentId": self.agent_id,
                "scopeKey": selector.scope_key,
                "aclBindings": selector.acl_bindings,
                "archivePath": str(archive_path),
                "previousStatus": str(row.get("status") or ""),
                "newStatus": "archived",
                "contentFingerprint": hashlib.sha256(
                    _normalized_text(str(row.get("content") or "")).encode("utf-8")
                ).hexdigest(),
            }
            self.audit_mutation({**audit_base, "result": "attempted"})
            update_result = table.update(
                where=(
                    f"id = '{memory_id}' AND {selector.where()} "
                    "AND (status = 'active' OR status = 'superseded')"
                ),
                values={"status": "archived"},
            )
            rows_updated = getattr(update_result, "rows_updated", None)
            if rows_updated is not None and int(rows_updated) != 1:
                raise RuntimeError("GC lifecycle mutation did not update exactly one card")
            verified = self._filter_rows(
                table.search().where(
                    f"id = '{memory_id}' AND {selector.where()}"
                ).limit(2).to_list(),
                selector,
            )
            if len(verified) != 1 or str(verified[0].get("status") or "") != "archived":
                raise RuntimeError("GC lifecycle mutation could not be verified")
            self.audit_mutation({**audit_base, "result": "committed"})
            archived.append(memory_id)
        result = {
            "scanned": len(rows),
            "archived": archived,
            "count": len(archived),
            "hardDeleted": 0,
            "selected": page["selected"],
            "planned": planned,
            "persisted": len(archived) * 2,
            "executed": len(archived),
            "complete": page["complete"],
            "truncated": page["truncated"],
            "nextCursor": page["nextCursor"],
        }
        self._commit_job_page(page)
        return result

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
        workspace_dir = self._scope_workspace_dir(selector)
        feedback = self._scoped_jsonl(
            self.workspace_dir,
            workspace_dir,
            ".adaptive-learning/feedback-log.jsonl",
            selector,
        )
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
            if metadata.get("neverForget") or str(metadata.get("memoryClass") or "") == "core":
                continue
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

    def _memory_rows(self) -> list[dict[str, Any]]:
        """Read authoritative memory cards without creating a namespace."""
        table = self._memory_table()
        if table is None:
            return []
        try:
            return [dict(row) for row in table.to_arrow().to_pylist()]
        except Exception:
            return []

    def _memory_table(self) -> Any | None:
        """Open the authoritative memory-card table without creating it."""
        try:
            import lancedb
            writer, _ = resolve_namespace_routes(
                self.data_dir, self.agent_id, self.config
            )
            database = lancedb.connect(str(writer.path))
            return database.open_table("memories") if "memories" in database.table_names() else None
        except Exception:
            return None

    @staticmethod
    def _critical_timestamp(value: Any) -> int | None:
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return int(value)
        text = str(value or "").strip()
        if not text:
            return None
        try:
            return int(float(text))
        except ValueError:
            try:
                parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
            except ValueError:
                return None
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return int(parsed.timestamp() * 1000)

    @staticmethod
    def _critical_acl_matches(card: Mapping[str, Any], selector: _ScopeSelector) -> bool:
        """Require the card's explicit binding to agree with the request owner."""
        if str(card.get("agentId") or "").strip() != selector.agent_id:
            return False
        if _row_scope_key(card) != selector.scope_key:
            return False
        acl = card.get("aclBindings")
        if not isinstance(acl, Mapping):
            # A scope key without its binding is not enough for a review action.
            return False
        expected = selector.acl_bindings
        direct_aliases = {
            "agentId": "agentId",
            "scopeKey": "scopeKey",
            "scopeType": "scopeType",
            "workspaceIdentity": "workspaceIdentity",
            "platform": "ownerPlatform",
            "userId": "ownerUser",
            "chatId": "chatScope",
            "account": "account",
        }
        for expected_key, card_key in direct_aliases.items():
            if card_key in card and str(card.get(card_key) or "") != str(expected.get(expected_key) or ""):
                return False
        aliases = {
            "workspace": "workspaceIdentity",
            "user": "userId",
            "chat": "chatId",
            "key": "scopeKey",
        }
        for raw_key, expected_value in expected.items():
            key = aliases.get(raw_key, raw_key)
            actual = acl.get(raw_key, acl.get(key))
            if str(actual or "") != str(expected_value or ""):
                return False
        return True

    def _critical_cards(self, selector: _ScopeSelector) -> list[dict[str, Any]]:
        """Join cards with their transactionally bound metadata projection."""
        metadata_by_id: dict[tuple[str, str], dict[str, Any]] = {}
        for row in self._metadata_rows():
            card_id = str(row.get("id") or "")
            metadata = self._metadata_json(row)
            if card_id:
                key = (card_id, _row_scope_key(metadata) or _row_scope_key(row))
                metadata_by_id[key] = {**metadata, **row}
        cards: dict[tuple[str, str], dict[str, Any]] = {}
        for row in self._memory_rows():
            card_id = str(row.get("id") or "")
            if not card_id:
                continue
            key = (card_id, _row_scope_key(row))
            cards[key] = {**metadata_by_id.get(key, {}), **row}
            if not isinstance(cards[key].get("aclBindings"), Mapping):
                projected = metadata_by_id.get(key, {}).get("aclBindings")
                if isinstance(projected, Mapping):
                    cards[key]["aclBindings"] = projected
        for key, row in metadata_by_id.items():
            cards.setdefault(key, row)
        return [
            card for card in cards.values()
            if self._critical_acl_matches(card, selector)
        ]

    def _critical_candidates(
        self,
        selector: _ScopeSelector,
        *,
        older_than_ms: int | None = None,
    ) -> list[dict[str, Any]]:
        """Filter cards before applying any output/page limit."""
        candidates = []
        for card in self._critical_cards(selector):
            if str(card.get("type") or "") not in CRITICAL_TYPES:
                continue
            if str(card.get("status") or "") != "active":
                continue
            if is_confirmed(card.get("confirmed")):
                continue
            created_at = self._critical_timestamp(card.get("createdAt"))
            if older_than_ms is not None and (created_at is None or created_at > older_than_ms):
                continue
            card["_criticalSortKey"] = (created_at or 0, str(card.get("id") or ""))
            candidates.append(card)
        return sorted(candidates, key=lambda card: card["_criticalSortKey"])

    def critical_review_page(
        self,
        *,
        limit: int = 500,
        cursor: str | None = None,
        acl_bindings: Any = None,
        scope_key: str | None = None,
        aclBindings: Any = None,
        scopeKey: str | None = None,
        older_than_ms: int | None = None,
    ) -> dict[str, Any]:
        """Return a bounded, deterministic page of scope-valid critical cards."""
        acl_bindings = aclBindings if aclBindings is not None else acl_bindings
        scope_key = scopeKey if scopeKey is not None else scope_key
        selector = self._scope_selector(acl_bindings=acl_bindings, scope_key=scope_key)
        owner = {
            "agentId": selector.agent_id,
            "scopeKey": selector.scope_key,
            "aclBindings": selector.acl_bindings,
        }
        candidates = self._critical_candidates(selector, older_than_ms=older_than_ms)
        if cursor:
            after = decode_critical_cursor(cursor, owner)
            candidates = [item for item in candidates if item["_criticalSortKey"] > after]
        page_limit = max(1, min(int(limit), 500))
        page = candidates[:page_limit]
        refs = assign_short_refs([str(item["id"]) for item in candidates])
        for item in page:
            item["shortRef"] = refs[str(item["id"])]
            item.pop("_criticalSortKey", None)
        next_cursor = None
        if len(candidates) > page_limit:
            last = page[-1]
            next_cursor = encode_critical_cursor(owner, (self._critical_timestamp(last.get("createdAt")) or 0, str(last["id"])))
        return {"items": page, "nextCursor": next_cursor, "hasMore": next_cursor is not None}

    def critical_items(
        self,
        status: str | None = "pending_review",
        *,
        limit: int = 500,
        cursor: str | None = None,
        acl_bindings: Any = None,
        scope_key: str | None = None,
        aclBindings: Any = None,
        scopeKey: str | None = None,
    ) -> list[dict[str, Any]]:
        """Return pending reviews from cards; other statuses remain audit-only."""
        acl_bindings = aclBindings if aclBindings is not None else acl_bindings
        scope_key = scopeKey if scopeKey is not None else scope_key
        selector = self._scope_selector(
            acl_bindings=acl_bindings, scope_key=scope_key
        )
        state_dir = self._scope_state_dir(selector)
        latest: dict[str, dict[str, Any]] = {}
        for item in self._scoped_jsonl(
            self.state_dir, state_dir, "critical-push.jsonl", selector
        ):
            if not _row_matches_scope(item, selector):
                continue
            memory_id = str(item.get("id") or "")
            if memory_id:
                latest[memory_id] = item
        if status == "pending_review":
            page = self.critical_review_page(
                limit=limit,
                cursor=cursor,
                acl_bindings=acl_bindings,
                scope_key=scope_key,
            )
            ledger = latest
            return [
                {
                    **item,
                    **({"reason": ledger[str(item["id"])]["reason"]} if "reason" in ledger.get(str(item["id"]), {}) else {}),
                    "status": "pending_review",
                }
                for item in page["items"]
                if not ledger
                or str(item["id"]) not in ledger
                or ledger[str(item["id"])].get("status") == "pending_review"
            ]
        values = list(latest.values())
        if status is not None:
            values = [item for item in values if item.get("status") == status]
        return values[: max(1, min(int(limit), 500))]

    def critical_reference_map(
        self,
        *,
        acl_bindings: Any = None,
        scope_key: str | None = None,
        aclBindings: Any = None,
        scopeKey: str | None = None,
    ) -> dict[str, str]:
        """Kürzeste eindeutige Kurzreferenz je ausstehender Critical-Review."""
        pending = self.critical_items(
            "pending_review",
            acl_bindings=aclBindings if aclBindings is not None else acl_bindings,
            scope_key=scopeKey if scopeKey is not None else scope_key,
        )
        return assign_short_refs([str(item["id"]) for item in pending])

    def resolve_critical_reference(
        self,
        reference: str,
        *,
        acl_bindings: Any = None,
        scope_key: str | None = None,
        aclBindings: Any = None,
        scopeKey: str | None = None,
    ) -> dict[str, Any]:
        """Löst eine Kurzreferenz (oder vollständige UUID) gegen ausstehende
        Reviews auf. Liefert ``{"ok": True, "id": ...}`` oder ein Fehlerobjekt.
        """
        pending = self.critical_items(
            "pending_review",
            acl_bindings=aclBindings if aclBindings is not None else acl_bindings,
            scope_key=scopeKey if scopeKey is not None else scope_key,
        )
        return resolve_short_ref(reference, pending)

    def review_critical_by_reference(
        self,
        reference: str,
        decision: str,
        *,
        acl_bindings: Any = None,
        scope_key: str | None = None,
        aclBindings: Any = None,
        scopeKey: str | None = None,
    ) -> dict[str, Any]:
        """Accept/Reject über Kurzreferenz oder vollständige UUID."""
        acl_bindings = aclBindings if aclBindings is not None else acl_bindings
        scope_key = scopeKey if scopeKey is not None else scope_key
        resolved = self.resolve_critical_reference(
            reference, acl_bindings=acl_bindings, scope_key=scope_key
        )
        if not resolved["ok"]:
            return {"updated": False, "reason": resolved["error"], "reference": reference}
        return self.review_critical(
            resolved["id"], decision, acl_bindings=acl_bindings, scope_key=scope_key
        )

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
        workspace_dir = self._scope_workspace_dir(selector)
        neo_dir = self._scope_neo_dir(selector)
        return generate_obsidian_control_room(
            workspace_dir,
            self.agent_id,
            metadata_rows=self._metadata_rows_for_scope(selector),
            episodes=[
                row for row in self._scoped_jsonl(self.neo_dir, neo_dir, "episodes.jsonl", selector)
                if _row_matches_scope(row, selector)
            ],
            dreams=[
                row for row in self._scoped_jsonl(self.neo_dir, neo_dir, "dream-diary.jsonl", selector)
                if _row_matches_scope(row, selector)
            ],
            contradictions=[
                row for row in self._scoped_jsonl(self.neo_dir, neo_dir, "contradiction-disclosure.jsonl", selector)
                if _row_matches_scope(row, selector)
            ],
            open_threads=[
                row for row in self._scoped_jsonl(self.neo_dir, neo_dir, "open-threads.jsonl", selector)
                if _row_matches_scope(row, selector)
            ],
        )

    @staticmethod
    def _ensure_confirmed_column(table: Any) -> None:
        """Ensure old memory tables can persist the review confirmation bit."""
        schema = table.schema() if callable(getattr(table, "schema", None)) else None
        fields = getattr(schema, "fields", ()) if schema is not None else ()
        names = {str(getattr(field, "name", "")) for field in fields}
        if "confirmed" not in names:
            add_columns = getattr(table, "add_columns", None)
            if not callable(add_columns):
                raise RuntimeError("critical card confirmation column unavailable")
            add_columns({"confirmed": "0"})

    def review_critical(
        self,
        memory_id: str,
        decision: str,
        *,
        acl_bindings: Any = None,
        scope_key: str | None = None,
        aclBindings: Any = None,
        scopeKey: str | None = None,
    ) -> dict[str, Any]:
        """Revalidate and mutate the current card before appending ledger state."""
        memory_id = safe_memory_id(memory_id)
        if decision not in {"accept", "reject"}:
            raise ValueError("decision must be accept or reject")
        acl_bindings = aclBindings if aclBindings is not None else acl_bindings
        scope_key = scopeKey if scopeKey is not None else scope_key
        selector = self._scope_selector(acl_bindings=acl_bindings, scope_key=scope_key)
        pending = {
            item["id"]: item
            for item in self.critical_items(
                "pending_review", acl_bindings=acl_bindings, scope_key=scope_key
            )
        }
        if memory_id not in pending:
            return {"updated": False, "reason": "not-pending", "id": memory_id}
        current = next(
            (card for card in self._critical_candidates(selector) if str(card.get("id")) == memory_id),
            None,
        )
        actual = next(
            (
                row
                for row in self._memory_rows()
                if str(row.get("id") or "") == memory_id
                and _row_matches_scope(row, selector)
            ),
            None,
        )
        if current is None or actual is None:
            return {"updated": False, "reason": "card-changed", "id": memory_id}
        table = self._memory_table()
        if table is None:
            return {"updated": False, "reason": "card-unavailable", "id": memory_id}
        try:
            self._ensure_confirmed_column(table)
            safe_agent = self.agent_id.replace("'", "''")
            safe_scope = selector.scope_key.replace("'", "''")
            safe_type = str(current["type"]).replace("'", "''")
            clauses = [
                f"id = '{memory_id}' AND agentId = '{safe_agent}' "
                f"AND scopeKey = '{safe_scope}' AND status = 'active' "
                f"AND type = '{safe_type}' "
                "AND (confirmed IS NULL OR confirmed = false OR confirmed = 0)"
            ]
            direct_fields = {
                "scopeType": current.get("scopeType"),
                "workspaceIdentity": current.get("workspaceIdentity"),
                "ownerPlatform": current.get("ownerPlatform"),
                "ownerUser": current.get("ownerUser"),
                "chatScope": current.get("chatScope"),
                "account": current.get("account"),
            }
            for field, value in direct_fields.items():
                if field in actual:
                    clauses.append(f"{field} = '{str(value or '').replace(chr(39), chr(39) * 2)}'")
            where = " AND ".join(clauses)
            values = {"confirmed": 1}
            if decision == "reject":
                values["type"] = NON_CRITICAL_TYPE
            update_result = table.update(where=where, values=values)
            rows_updated = getattr(update_result, "rows_updated", None)
            if rows_updated is not None and int(rows_updated) != 1:
                return {"updated": False, "reason": "card-changed", "id": memory_id}
        except Exception:
            return {"updated": False, "reason": "card-update-failed", "id": memory_id}
        verified = next(
            (
                row
                for row in self._memory_rows()
                if str(row.get("id") or "") == memory_id
                and _row_matches_scope(row, selector)
            ),
            None,
        )
        expected_type = NON_CRITICAL_TYPE if decision == "reject" else str(current["type"])
        if (
            verified is None
            or str(verified.get("status") or "") != "active"
            or not is_confirmed(verified.get("confirmed"))
            or str(verified.get("type") or "") != expected_type
        ):
            return {"updated": False, "reason": "card-update-unverified", "id": memory_id}
        transition = {
            "id": memory_id,
            "agentId": self.agent_id,
            "scopeKey": selector.scope_key,
            "status": "accepted" if decision == "accept" else "rejected",
            "reviewedAt": _utcnow(),
        }
        self.audit_mutation({
            "operation": "critical-review",
            "action": decision,
            "id": memory_id,
            "agentId": self.agent_id,
            "scopeKey": selector.scope_key,
            "aclBindings": selector.acl_bindings,
            "previousType": str(current.get("type") or ""),
            "newType": str(values.get("type") or current.get("type") or ""),
        })
        self._append_jsonl(
            self._scope_state_dir(selector) / "critical-push.jsonl", transition
        )
        return {"updated": True, **transition}

    def mark_criticals_notified(
        self,
        memory_ids: list[str],
        *,
        acl_bindings: Any = None,
        scope_key: str | None = None,
        aclBindings: Any = None,
        scopeKey: str | None = None,
    ) -> dict[str, Any]:
        """Record successful delivery while keeping proposals pending for review."""
        acl_bindings = aclBindings if aclBindings is not None else acl_bindings
        scope_key = scopeKey if scopeKey is not None else scope_key
        selector = self._scope_selector(
            acl_bindings=acl_bindings, scope_key=scope_key
        )
        pending = {
            item["id"]: item
            for item in self.critical_items(
                "pending_review", acl_bindings=acl_bindings, scope_key=scope_key
            )
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
            self._append_jsonl(
                self._scope_state_dir(selector) / "critical-push.jsonl", transition
            )
            notified.append(memory_id)
        return {"notified": notified, "count": len(notified)}

    def auto_accept_stale_criticals(
        self,
        max_age_ms: int = 604_800_000,
        *,
        acl_bindings: Any = None,
        scope_key: str | None = None,
        aclBindings: Any = None,
        scopeKey: str | None = None,
    ) -> dict[str, Any]:
        """Accept critical proposals left pending beyond the configured age."""
        acl_bindings = aclBindings if aclBindings is not None else acl_bindings
        scope_key = scopeKey if scopeKey is not None else scope_key
        cutoff = _now_ms() - max(0, int(max_age_ms))
        accepted = []
        stale = self.critical_review_page(
            older_than_ms=cutoff,
            acl_bindings=acl_bindings,
            scope_key=scope_key,
        )["items"]
        for item in stale:
            result = self.review_critical(
                str(item["id"]),
                "accept",
                acl_bindings=acl_bindings,
                scope_key=scope_key,
            )
            if result["updated"]:
                accepted.append(str(item["id"]))
        return {"accepted": accepted, "count": len(accepted)}

    def update_reminder(
        self,
        memory_id: str,
        action: str,
        *,
        acl_bindings: Any = None,
        scope_key: str | None = None,
        aclBindings: Any = None,
        scopeKey: str | None = None,
    ) -> dict[str, Any]:
        """Acknowledge or cancel a reminder while preserving all card metadata."""
        memory_id = safe_memory_id(memory_id)
        if action not in {"acknowledge", "cancel", "present"}:
            raise ValueError("action must be acknowledge, cancel, or present")
        acl_bindings = aclBindings if aclBindings is not None else acl_bindings
        scope_key = scopeKey if scopeKey is not None else scope_key
        selector = self._scope_selector(
            acl_bindings=acl_bindings, scope_key=scope_key
        )
        table = self._metadata_table()
        if table is None:
            return {"updated": False, "reason": "metadata-table-unavailable"}
        all_rows = [dict(row) for row in self._metadata_rows()]
        matches = []
        for row in all_rows:
            metadata = self._metadata_json(row)
            candidate = metadata if _row_scope_key(metadata) else row
            if (
                str(row.get("id") or "") == memory_id
                and _row_matches_scope(candidate, selector)
            ):
                matches.append(row)
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
        import lancedb

        database = lancedb.connect(str(self.data_dir / "lancedb" / self.agent_id))
        database.create_table("metadata", data=all_rows, mode="overwrite")
        event = {
            "id": memory_id,
            "agentId": self.agent_id,
            "scopeKey": selector.scope_key,
            "aclBindings": selector.acl_bindings,
            "action": action,
            "createdAt": _utcnow(),
        }
        self._append_jsonl(
            self._scope_neo_dir(selector) / "reminder-dispatch-ledger.jsonl", event
        )
        return {"updated": True, **event}

    def status(
        self,
        *,
        acl_bindings: Any = None,
        scope_key: str | None = None,
        aclBindings: Any = None,
        scopeKey: str | None = None,
    ) -> dict[str, Any]:
        """Return feature-store health and imported artifact counts."""
        acl_bindings = aclBindings if aclBindings is not None else acl_bindings
        scope_key = scopeKey if scopeKey is not None else scope_key
        selector = self._scope_selector(
            acl_bindings=acl_bindings, scope_key=scope_key
        )
        neo_dir = self._scope_neo_dir(selector)
        workspace_dir = self._scope_workspace_dir(selector)
        return {
            "agentId": self.agent_id,
            "scopeKey": selector.scope_key,
            "graphEdges": len(self._scoped_jsonl(self.neo_dir, neo_dir, "memory-graph.jsonl", selector)),
            "dreams": len(self._scoped_jsonl(self.neo_dir, neo_dir, "dream-diary.jsonl", selector)),
            "episodes": len(self._scoped_jsonl(self.neo_dir, neo_dir, "episodes.jsonl", selector)),
            "feedback": len(self._scoped_jsonl(self.workspace_dir, workspace_dir, ".adaptive-learning/feedback-log.jsonl", selector)),
            "dueReminders": len(self.due_reminders(acl_bindings=selector.acl_bindings)),
            "pendingCriticals": len(self.critical_items(acl_bindings=selector.acl_bindings)),
            "obsidianMirror": str(workspace_dir / "plur1bus" / "memories"),
            "workspace": str(workspace_dir),
            "graphPath": str(neo_dir / "memory-graph.jsonl"),
            "dreamPath": str(neo_dir / "dream-diary.jsonl"),
        }

    def _metadata_for(self, record: dict[str, Any], *, importance: float | None = None) -> dict[str, Any]:
        content = str(record.get("content") or "")
        is_correction = str(record.get("sourceRole") or "") == "correction"
        emotion, intensity = self._emotion(content)
        importance_value = self._importance(content, str(record.get("sourceRole") or "")) if importance is None else max(0.0, min(1.0, float(importance)))
        manual_core = importance is not None and importance_value >= 1.0
        return {
            "text": content,
            "summary": content[:500],
            "importance": importance_value,
            "category": "conversation",
            "scope": str(record.get("scopeType") or "agent-private"),
            "scopeKey": str(record.get("scopeKey") or ""),
            "aclBindings": record.get("aclBindings") or {},
            "type": str(record.get("type") or "observation"),
            "confirmed": bool(record.get("confirmed", False)),
            "emotionalDominant": emotion,
            "emotionalIntensity": intensity,
            "moodContextAtCapture": self._mood.state(),
            "retrievalCount": 1 if is_correction else 0,
            "lastRetrievedAt": _now_ms() if is_correction else 0,
            "memoryStrength": 1.15 if is_correction else 1.0,
            "halfLifeDays": 36500 if manual_core else (180 if str(record.get("sourceRole")) == "user" else 30),
            "lastDynamicsAt": _now_ms(),
            "neverForget": manual_core,
            "coreMemoryScore": 1.0 if manual_core else 0.0,
            "memoryClass": "core" if manual_core else "standard",
            "coreMemoryReason": "manual_importance_marker" if manual_core else "",
            "status": str(record.get("status") or "active"),
            "memoryKind": "memory",
            "reminderStatus": "",
            "remindAt": 0,
        }

    def _store_metadata(self, record: dict[str, Any], *, importance: float | None = None) -> None:
        agent_dir = self.data_dir / "lancedb" / self.agent_id
        try:
            import lancedb
        except ImportError:
            return
        database = lancedb.connect(str(agent_dir))
        metadata = self._metadata_for(record, importance=importance)
        row = {
            "id": record["id"],
            "agentId": self.agent_id,
            "scopeKey": str(record.get("scopeKey") or ""),
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
        neo_dir = self._scope_neo_dir(selector)
        state_dir = self._scope_state_dir(selector)
        try:
            neighbors = table.search(record["vector"]).where(
                selector.where(" AND status = 'active'")
            ).limit(4).to_list()
            neighbors = self._filter_rows(neighbors, selector)
        except Exception as error:
            self._append_jsonl(state_dir / "domain-errors.jsonl", {
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
                self._append_jsonl(neo_dir / "memory-graph.jsonl", {
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
                self._append_jsonl(neo_dir / "contradiction-disclosure.jsonl", {
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
            self._append_jsonl(neo_dir / "memory-graph.jsonl", {
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
            self._update_graph_links(str(record["id"]), target, selector=selector)

    def _write_obsidian_note(self, record: dict[str, Any]) -> None:
        selector = self._scope_selector(record=record)
        note = self._scope_workspace_dir(selector) / "plur1bus" / "memories" / f"{record['id']}.md"
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

    def _update_graph_links(
        self, source: str, target: str, *, selector: _ScopeSelector
    ) -> None:
        workspace_dir = self._scope_workspace_dir(selector)
        for memory_id, linked_id in ((source, target), (target, source)):
            note = workspace_dir / "plur1bus" / "memories" / f"{memory_id}.md"
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
        for edge in self._scoped_jsonl(
            self.neo_dir,
            self._scope_neo_dir(selector),
            "memory-graph.jsonl",
            selector,
        ):
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
        scoped_path = (
            self._scope_workspace_dir(selector)
            / ".plur1bus"
            / "semantic-lens-index.json"
        )
        index = self._read_json(scoped_path)
        if not index and scoped_path != self.workspace_dir / ".plur1bus" / "semantic-lens-index.json":
            index = self._read_json(
                self.workspace_dir / ".plur1bus" / "semantic-lens-index.json"
            )
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
        scoped_path = (
            self._scope_workspace_dir(selector) / ".plur1bus" / "link-index.json"
        )
        index = self._read_json(scoped_path)
        if not index and scoped_path != self.workspace_dir / ".plur1bus" / "link-index.json":
            index = self._read_json(
                self.workspace_dir / ".plur1bus" / "link-index.json"
            )
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
        selector = self._scope_selector(
            acl_bindings=entry.get("aclBindings"),
            scope_key=str(entry.get("scopeKey") or "") or None,
        )
        self._append_jsonl(
            self._scope_state_dir(selector) / "destructive-operations.jsonl",
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
