"""Deterministic cognition helpers used by the Hermes PLUR1BUS runtime."""

from __future__ import annotations

import re
import threading
from datetime import datetime, timedelta, timezone
from typing import Any, Callable


_EMOTIONS = {
    "joy": {"glad", "great", "happy", "love", "freue", "super", "danke", "wunderbar"},
    "sadness": {"sad", "sorry", "traurig", "schade", "verlust", "leider"},
    "anger": {"angry", "hate", "wut", "sauer", "nervt", "ärger"},
    "fear": {"afraid", "fear", "anxious", "angst", "sorge", "unsicher"},
    "surprise": {"surprised", "unexpected", "überrascht", "unerwartet", "wow"},
}
_POSITIVE = _EMOTIONS["joy"] | {"good", "yes", "richtig", "gut", "gelungen"}
_NEGATIVE = (
    _EMOTIONS["sadness"]
    | _EMOTIONS["anger"]
    | _EMOTIONS["fear"]
    | {"bad", "wrong", "falsch", "kaputt", "problem", "fehler"}
)
_NEGATIONS = {"not", "never", "no", "nicht", "nie", "kein", "keine", "keinen"}
_STOP = {
    "aber", "auch", "das", "der", "die", "ein", "eine", "for", "ist", "mit",
    "the", "und", "von", "was", "with", "you",
}


_T2_CLASSIFIERS: dict[str, Callable[[str], dict[str, Any]]] = {}
_T2_CLASSIFIER_LOCK = threading.RLock()
_MAX_T2_CLASSIFIERS = 8


def _normalize_classifier_result(value: Any) -> dict[str, Any] | None:
    """Validate a local classifier result before it influences persistent state."""
    if not isinstance(value, dict):
        return None
    dominant = str(value.get("dominant") or "").lower()
    valence = str(value.get("valence") or "").lower()
    if not dominant or valence not in {"positive", "negative", "neutral"}:
        return None
    try:
        intensity = max(0.0, min(1.0, float(value.get("intensity"))))
    except (TypeError, ValueError):
        return None
    return {"dominant": dominant, "intensity": round(intensity, 4), "valence": valence}


def _local_t2_classifier(config: dict[str, Any]) -> tuple[Callable[[str], dict[str, Any]] | None, str]:
    """Lazily load an explicitly configured local-only emotion classifier."""
    model_name = str(config.get("model") or "").strip()
    backend = str(config.get("backend") or "transformers").lower()
    if not model_name:
        return None, "not-configured"
    cache_key = f"{backend}:{model_name}:{repr(config.get('labelMap'))}:{repr(config.get('labels'))}"
    with _T2_CLASSIFIER_LOCK:
        cached = _T2_CLASSIFIERS.get(cache_key)
        if cached is not None:
            return cached, "ready"
        try:
            if backend == "transformers":
                from transformers import AutoModelForSequenceClassification, AutoTokenizer  # type: ignore[import-not-found]
                import torch  # type: ignore[import-not-found]

                tokenizer = AutoTokenizer.from_pretrained(model_name, local_files_only=True)
                model = AutoModelForSequenceClassification.from_pretrained(model_name, local_files_only=True)
                model.eval()
                label_map = config.get("labelMap") if isinstance(config.get("labelMap"), dict) else {}
                id_to_label = getattr(model.config, "id2label", {})

                def classify(text: str) -> dict[str, Any]:
                    inputs = tokenizer(text, truncation=True, max_length=512, return_tensors="pt")
                    with torch.inference_mode():
                        logits = model(**inputs).logits[0]
                    scores = logits.softmax(dim=-1).tolist()
                    index = max(range(len(scores)), key=scores.__getitem__)
                    raw_label = str(id_to_label.get(index, index))
                    dominant = str(label_map.get(raw_label, raw_label)).lower()
                    valence = "positive" if dominant in {"joy", "love", "trust"} else "negative" if dominant in {"sadness", "anger", "fear"} else "neutral"
                    return {"dominant": dominant, "intensity": scores[index], "valence": valence}

            elif backend == "sentence-transformers":
                from sentence_transformers import SentenceTransformer  # type: ignore[import-not-found]

                labels = config.get("labels") if isinstance(config.get("labels"), dict) else {}
                prototypes = {str(name).lower(): str(example) for name, example in labels.items() if str(example).strip()}
                if not prototypes:
                    return None, "sentence-transformers-labels-required"
                model = SentenceTransformer(model_name, local_files_only=True)
                names = list(prototypes)
                vectors = model.encode([prototypes[name] for name in names], normalize_embeddings=True)

                def classify(text: str) -> dict[str, Any]:
                    vector = model.encode([text], normalize_embeddings=True)[0]
                    scores = [sum(float(a) * float(b) for a, b in zip(vector, prototype)) for prototype in vectors]
                    index = max(range(len(scores)), key=scores.__getitem__)
                    dominant = names[index]
                    valence = "positive" if dominant in {"joy", "love", "trust"} else "negative" if dominant in {"sadness", "anger", "fear"} else "neutral"
                    return {"dominant": dominant, "intensity": max(0.0, min(1.0, (scores[index] + 1.0) / 2.0)), "valence": valence}

            else:
                return None, "unsupported-backend"
        except (ImportError, OSError, RuntimeError, TypeError, ValueError):
            return None, "local-model-unavailable"
        if len(_T2_CLASSIFIERS) >= _MAX_T2_CLASSIFIERS:
            # Model instances are process-local and potentially large.  Keep a
            # bounded cache instead of retaining arbitrary profile models.
            _T2_CLASSIFIERS.pop(next(iter(_T2_CLASSIFIERS)))
        _T2_CLASSIFIERS[cache_key] = classify
        return classify, "ready"


def _tokens(text: str) -> list[str]:
    return re.findall(r"[\wäöüß-]+", str(text or "").lower())


def analyze_text(text: str, *, now: datetime | None = None) -> dict[str, Any]:
    """Return emotion, quality, temporal, and intent signals without an LLM call."""
    words = _tokens(text)
    counts = {
        emotion: sum(1 for word in words if word in lexicon)
        for emotion, lexicon in _EMOTIONS.items()
    }
    dominant = max(counts, key=counts.get) if any(counts.values()) else "neutral"
    emotional_hits = sum(counts.values())
    intensity = min(1.0, emotional_hits / max(2.0, len(words) * 0.12))
    positive = sum(1 for word in words if word in _POSITIVE)
    negative = sum(1 for word in words if word in _NEGATIVE)
    valence = "positive" if positive > negative else "negative" if negative > positive else "neutral"
    temporal = parse_temporal_hints(text, now=now)
    has_subject = bool(re.search(r"\b(ich|i|we|wir|er|sie|they|he|she|bernd)\b", text, re.I))
    has_predicate = bool(re.search(r"\b(ist|sind|war|hat|will|is|are|was|has|wants?)\b", text, re.I))
    specificity = min(1.0, (len(set(words)) / 18.0) + (0.2 if temporal else 0.0))
    fact_quality = round(min(1.0, specificity + (0.15 if has_subject and has_predicate else 0.0)), 4)
    return {
        "emotion": {
            "dominant": dominant,
            "intensity": round(intensity, 4),
            "valence": valence,
        },
        "factQuality": fact_quality,
        "temporal": temporal,
        "question": "?" in str(text),
        "continuationSignal": bool(
            re.search(r"\b(weiter|nochmal|again|continue|wie gesagt|as discussed)\b", text, re.I)
        ),
    }


def analyze_text_tiered(
    text: str,
    config: dict[str, Any],
    *,
    complete_json=None,
    t2_classifier: Callable[[str], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Route emotion analysis through T1/T2/T3 with explicit fail-soft metadata."""
    result = analyze_text(text)
    emotion_config = dict(config.get("emotion") or {})
    requested = str(emotion_config.get("tier") or "auto").lower()
    if requested not in {"auto", "t1", "t2", "t3"}:
        requested = "auto"
    result["emotion"]["requestedTier"] = requested
    result["emotion"]["tierUsed"] = "t1"
    t2_config = emotion_config.get("t2") if isinstance(emotion_config.get("t2"), dict) else {}
    use_t2 = requested in {"auto", "t2", "t3"} and t2_config.get("enabled") is not False
    t2_reason = "disabled"
    if use_t2:
        classifier = t2_classifier
        if classifier is None:
            classifier, t2_reason = _local_t2_classifier(t2_config)
        else:
            t2_reason = "injected"
        if classifier is not None:
            try:
                classified = _normalize_classifier_result(classifier(text))
            except (RuntimeError, TypeError, ValueError):
                classified = None
                t2_reason = "classifier-error"
            if classified is not None:
                result["emotion"].update({**classified, "tierUsed": "t2"})
            else:
                t2_reason = "invalid-classifier-result"
        if result["emotion"]["tierUsed"] != "t2":
            result["emotion"]["fallback"] = f"t2-{t2_reason}-to-t1"
    should_use_t3 = requested == "t3" or (
        requested == "auto"
        and (emotion_config.get("t3") or {}).get("enabled") is True
        and result["emotion"]["intensity"] < float(
            (emotion_config.get("t3") or {}).get(
                "escalationConfidence", 0.85
            )
        )
    )
    if not should_use_t3:
        return result
    if complete_json is None:
        result["emotion"]["fallback"] = f"t3-unavailable-to-{result['emotion']['tierUsed']}"
        return result
    try:
        classified = complete_json(
            "emotion-classification",
            (
                "Classify emotion as JSON with dominant, intensity 0..1, "
                "and valence positive|negative|neutral."
            ),
            text,
        )
        dominant = str(classified.get("dominant") or "neutral")
        intensity = max(0.0, min(1.0, float(classified.get("intensity") or 0)))
        valence = str(classified.get("valence") or "neutral")
        if valence not in {"positive", "negative", "neutral"}:
            raise ValueError("invalid valence")
        result["emotion"].update({
            "dominant": dominant,
            "intensity": round(intensity, 4),
            "valence": valence,
            "tierUsed": "t3",
        })
    except (RuntimeError, TypeError, ValueError) as error:
        result["emotion"]["fallback"] = f"t3-{type(error).__name__}-to-{result['emotion']['tierUsed']}"
    return result


def parse_temporal_hints(
    text: str,
    *,
    now: datetime | None = None,
) -> list[dict[str, str]]:
    """Parse a small safe subset of relative German and English time hints."""
    reference = now or datetime.now(timezone.utc)
    hints = []
    patterns = (
        (r"\b(heute|today)\b", 0),
        (r"\b(morgen|tomorrow)\b", 1),
        (r"\b(gestern|yesterday)\b", -1),
        (r"\b(übermorgen|day after tomorrow)\b", 2),
    )
    for pattern, days in patterns:
        match = re.search(pattern, text, re.I)
        if match:
            hints.append({
                "source": match.group(0),
                "resolvedDate": (reference + timedelta(days=days)).date().isoformat(),
            })
    return hints


def parse_temporal_range(
    text: str,
    *,
    now: datetime | None = None,
) -> dict[str, str] | None:
    """Resolve common relative periods and quarter references to UTC ranges."""
    reference = now or datetime.now(timezone.utc)
    value = str(text or "")
    days_match = re.search(
        r"\b(?:vor|ago)\s*(\d{1,4})\s*(?:tagen?|days?)\b"
        r"|\b(\d{1,4})\s*(?:tagen?|days?)\s*(?:zuvor|ago)\b",
        value,
        re.I,
    )
    if days_match:
        days = int(days_match.group(1) or days_match.group(2))
        start = (reference - timedelta(days=days)).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        return {
            "start": start.isoformat(),
            "end": (start + timedelta(days=1)).isoformat(),
            "source": days_match.group(0),
        }
    if re.search(r"\b(letzten monat|last month)\b", value, re.I):
        current_month = reference.replace(
            day=1, hour=0, minute=0, second=0, microsecond=0
        )
        previous_day = current_month - timedelta(days=1)
        start = previous_day.replace(day=1)
        return {
            "start": start.isoformat(),
            "end": current_month.isoformat(),
            "source": "last-month",
        }
    quarter = re.search(r"\bq([1-4])\s*(20\d{2})\b", value, re.I)
    if quarter:
        number = int(quarter.group(1))
        year = int(quarter.group(2))
        start_month = (number - 1) * 3 + 1
        start = datetime(year, start_month, 1, tzinfo=timezone.utc)
        if number == 4:
            end = datetime(year + 1, 1, 1, tzinfo=timezone.utc)
        else:
            end = datetime(year, start_month + 3, 1, tzinfo=timezone.utc)
        return {
            "start": start.isoformat(),
            "end": end.isoformat(),
            "source": quarter.group(0),
        }
    return None


def extract_open_threads(text: str, *, limit: int = 5) -> list[str]:
    """Extract explicit questions, TODOs, and future commitments as open threads."""
    threads = []
    for segment in re.split(r"(?<=[.!?])\s+|\n+", str(text or "")):
        candidate = segment.strip()
        if not candidate:
            continue
        if (
            candidate.endswith("?")
            or re.search(r"\b(todo|offen|später|later|noch machen|muss noch|will do)\b", candidate, re.I)
        ):
            threads.append(candidate[:500])
        if len(threads) >= limit:
            break
    return threads


def contradiction_score(first: str, second: str) -> float:
    """Score likely lexical contradictions with shared claims and opposite negation."""
    first_words = set(_tokens(first)) - _STOP
    second_words = set(_tokens(second)) - _STOP
    if not first_words or not second_words:
        return 0.0
    shared = first_words & second_words
    overlap = len(shared) / max(1, min(len(first_words), len(second_words)))
    first_negated = bool(first_words & _NEGATIONS)
    second_negated = bool(second_words & _NEGATIONS)
    if first_negated == second_negated or overlap < 0.35:
        return 0.0
    return round(min(1.0, overlap + 0.25), 4)
