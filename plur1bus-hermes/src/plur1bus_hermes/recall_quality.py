"""Automatic recall weighting for older assistant replies."""

import math
import re

from .valid_time import normalize_timestamp

_DAY = 86_400_000
_SMALL_TALK = re.compile(
    r"^\W*(?:danke|vielen dank|gern(?:e| geschehen)?|alles klar|freut mich|"
    r"super|klasse|perfekt|genial|wow|thanks|thank you|glad|awesome|great|"
    r"nice|sounds good|you'?re welcome|kein problem)\b",
    re.I,
)
_ANCHOR = re.compile(r"\d|https?://|[`“„\"]|\b[A-Za-z0-9]+[-_][A-Za-z0-9]+\b")


def _assistant_weight(row: dict, now_ms: int, floor: float) -> float:
    if row.get("sourceRole") != "assistant":
        return 1.0
    text = str(row.get("content") or "")
    if not text:
        return 1.0
    informative = len(text) >= 200 and _ANCHOR.search(text[:1500])
    stamp = normalize_timestamp(row.get("createdAt"))
    age = (now_ms - stamp) / _DAY if stamp else 0
    if informative:
        return max(floor, 0.85) if age >= 60 else 1.0
    age_weight = 0.55 if age >= 180 else 0.65 if age >= 60 else 0.8 if age >= 14 else 1.0
    tone_weight = 0.6 if len(text) <= 400 and _SMALL_TALK.search(text) else 1.0
    return max(floor, age_weight * tone_weight)


def apply_stale_assistant_weighting(rows: list[dict], now_ms: int, config: object) -> list[dict]:
    """Rank admitted candidates without altering records or comparing unlike scores."""
    if config is False:
        return rows
    options = config if isinstance(config, dict) else {}
    if options.get("enabled") is False or options.get("staleAssistant") is False:
        return rows
    floor = options.get("floor")
    floor = min(1.0, max(0.05, floor)) if type(floor) in (int, float) and math.isfinite(floor) else 0.35
    weights = [_assistant_weight(row, now_ms, floor) for row in rows]
    if all(weight == 1.0 for weight in weights):
        return rows
    scores = [row.get("rerankScore") for row in rows]
    if all(type(score) in (int, float) and math.isfinite(score) for score in scores):
        if any(not 0 <= score <= 1 for score in scores):
            # Local cross-encoders can return negative logits. A positive
            # monotone scale ensures the penalty never improves a rank.
            scores = [1 / (1 + math.exp(-max(-40, min(40, score)))) for score in scores]
    else:
        # Distances, reranker logits and lexical ranks have distinct scales.
        # Preserve the admitted order as the initial score for mixed results.
        scores = [1 / (1 + index / len(rows)) for index in range(len(rows))]
    return [
        row for row, _ in sorted(
            zip(rows, (score * weight for score, weight in zip(scores, weights))),
            key=lambda pair: pair[1], reverse=True,
        )
    ]
