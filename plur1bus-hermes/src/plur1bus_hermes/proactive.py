"""Persistent proactive pattern, afterthought, and meta-reflection governor."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def _read_json(path: Path, default: Any) -> Any:
    if not path.is_file():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, TypeError, ValueError):
        return default


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)


def _append_jsonl(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(value, ensure_ascii=False) + "\n")


def _vector(text: str, dimensions: int = 128) -> list[float]:
    vector = [0.0] * dimensions
    for token in re.findall(r"[\wäöüß-]{3,}", text.lower()):
        index = int(hashlib.sha256(token.encode("utf-8")).hexdigest()[:8], 16) % dimensions
        vector[index] += 1.0
    length = math.sqrt(sum(value * value for value in vector)) or 1.0
    return [value / length for value in vector]


def _cosine(first: list[float], second: list[float]) -> float:
    return sum(left * right for left, right in zip(first, second))


class ProactiveEngine:
    """Agent-local persistent governor for nudges, afterthoughts, and reflection."""

    def __init__(self, state_dir: Path, neo_dir: Path, workspace_dir: Path) -> None:
        self.state_dir = Path(state_dir)
        self.neo_dir = Path(neo_dir)
        self.workspace_dir = Path(workspace_dir)

    def _jsonl(self, path: Path) -> list[dict[str, Any]]:
        if not path.is_file():
            return []
        values = []
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                value = json.loads(line)
            except (TypeError, ValueError):
                continue
            if isinstance(value, dict):
                values.append(value)
        return values

    def detect_patterns(
        self,
        *,
        min_cluster_size: int = 3,
        similarity_threshold: float = 0.55,
    ) -> dict[str, Any]:
        turns = [
            turn
            for turn in self._jsonl(self.neo_dir / "turn-journal.jsonl")[-500:]
            if turn.get("role") == "user" and str(turn.get("content") or "").strip()
        ]
        clusters: list[dict[str, Any]] = []
        for turn in turns:
            text = str(turn["content"])
            vector = _vector(text)
            best = None
            best_score = 0.0
            for cluster in clusters:
                score = _cosine(vector, cluster["_centroid"])
                if score > best_score:
                    best, best_score = cluster, score
            if best is None or best_score < similarity_threshold:
                clusters.append({
                    "id": "p-" + hashlib.sha256(text.encode("utf-8")).hexdigest()[:12],
                    "turnIds": [str(turn.get("id") or "")],
                    "examples": [text[:500]],
                    "_vectors": [vector],
                    "_centroid": vector,
                })
            else:
                best["turnIds"].append(str(turn.get("id") or ""))
                best["examples"].append(text[:500])
                best["_vectors"].append(vector)
                count = len(best["_vectors"])
                best["_centroid"] = [
                    sum(item[index] for item in best["_vectors"]) / count
                    for index in range(len(vector))
                ]
        persisted = [
            {
                "id": cluster["id"],
                "size": len(cluster["turnIds"]),
                "turnIds": cluster["turnIds"],
                "examples": cluster["examples"][-5:],
            }
            for cluster in clusters
            if len(cluster["turnIds"]) >= min_cluster_size
        ]
        result = {"generatedAt": _utcnow(), "clusters": persisted}
        _write_json(self.state_dir / "pattern-clusters.json", result)
        return result

    def _consume_budget(self, topic_id: str, now: datetime) -> bool:
        path = self.state_dir / "proactive-governor.json"
        state = _read_json(path, {"day": "", "count": 0, "topics": {}})
        day = now.date().isoformat()
        if state.get("day") != day:
            state = {"day": day, "count": 0, "topics": {}}
        last = state.get("topics", {}).get(topic_id)
        if last:
            try:
                previous = datetime.fromisoformat(last)
            except ValueError:
                previous = now
            if (now - previous).total_seconds() < 86_400:
                return False
        if int(state.get("count") or 0) >= 3:
            return False
        state["count"] = int(state.get("count") or 0) + 1
        state.setdefault("topics", {})[topic_id] = now.isoformat()
        _write_json(path, state)
        return True

    def _enqueue(self, kind: str, topic_id: str, text: str) -> dict[str, Any]:
        message = {
            "id": str(uuid.uuid4()),
            "kind": kind,
            "topicId": topic_id,
            "text": text[:1000],
            "status": "pending",
            "createdAt": _utcnow(),
        }
        _append_jsonl(self.state_dir / "proactive-outbox.jsonl", message)
        return message

    def proactive_check(self, *, now: datetime | None = None) -> dict[str, Any]:
        reference = now or datetime.now(timezone.utc)
        patterns = self.detect_patterns()["clusters"]
        if not patterns:
            return {"skipped": True, "reason": "no-pattern"}
        pattern = max(patterns, key=lambda item: item["size"])
        if not self._consume_budget(str(pattern["id"]), reference):
            return {"skipped": True, "reason": "governor-budget-or-cooldown"}
        example = str(pattern["examples"][-1])
        message = self._enqueue(
            "pattern-nudge",
            str(pattern["id"]),
            f"Mir fällt ein wiederkehrendes Thema auf: {example[:500]}",
        )
        return {"skipped": False, "message": message}

    def afterthought(self, *, now: datetime | None = None) -> dict[str, Any]:
        reference = now or datetime.now(timezone.utc)
        episodes = self._jsonl(self.neo_dir / "episodes.jsonl")
        threads = [
            item
            for item in self._jsonl(self.neo_dir / "open-threads.jsonl")
            if item.get("status") == "open"
        ]
        if not episodes or not threads:
            return {"skipped": True, "reason": "no-open-outcome"}
        try:
            ended = datetime.fromisoformat(str(episodes[-1].get("endTime") or ""))
        except ValueError:
            return {"skipped": True, "reason": "invalid-episode-time"}
        if ended.tzinfo is None:
            ended = ended.replace(tzinfo=timezone.utc)
        age_minutes = (reference - ended).total_seconds() / 60
        if age_minutes < 30 or age_minutes > 120:
            return {"skipped": True, "reason": "outside-30-120-minute-window"}
        thread = threads[-1]
        topic_id = "afterthought:" + str(thread.get("id") or "")
        if not self._consume_budget(topic_id, reference):
            return {"skipped": True, "reason": "governor-budget-or-cooldown"}
        message = self._enqueue(
            "afterthought",
            topic_id,
            f"Mir ist zu „{str(thread.get('text') or '')[:400]}“ noch etwas eingefallen.",
        )
        return {"skipped": False, "message": message}

    def meta_reflect(self) -> dict[str, Any]:
        feedback = self._jsonl(
            self.workspace_dir / ".adaptive-learning" / "feedback-log.jsonl"
        )
        labels = [
            str(
                item.get("feedback")
                or item.get("rating")
                or item.get("value")
                or ""
            ).lower()
            for item in feedback
        ]
        positive = sum(label in {"useful", "positive", "+", "up"} for label in labels)
        negative = sum(label in {"incorrect", "negative", "-", "down"} for label in labels)
        neutral = sum(label in {"irrelevant", "neutral", "~"} for label in labels)
        precision = positive / max(1, positive + negative)
        recall = positive / max(1, positive + neutral)
        f1 = 2 * precision * recall / max(1e-9, precision + recall)
        report = {
            "generatedAt": _utcnow(),
            "feedbackCount": len(labels),
            "precision": round(precision, 4),
            "recall": round(recall, 4),
            "f1": round(f1, 4),
            "coverageGap": len(labels) < 5,
        }
        _write_json(self.state_dir / "meta-cognition-state.json", report)
        return report

    def pending_messages(self) -> list[dict[str, Any]]:
        latest: dict[str, dict[str, Any]] = {}
        for item in self._jsonl(self.state_dir / "proactive-outbox.jsonl"):
            if item.get("id"):
                latest[str(item["id"])] = item
        return [item for item in latest.values() if item.get("status") == "pending"]

    def mark_sent(self, message_ids: list[str]) -> None:
        pending = {item["id"]: item for item in self.pending_messages()}
        for message_id in message_ids:
            if message_id in pending:
                _append_jsonl(
                    self.state_dir / "proactive-outbox.jsonl",
                    {**pending[message_id], "status": "sent", "sentAt": _utcnow()},
                )
