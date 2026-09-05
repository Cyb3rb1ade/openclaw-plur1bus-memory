"""Bounded deterministic refinement for poor first-pass memory queries."""

from __future__ import annotations

import re


_QUESTION_FILLERS = {
    "can", "could", "do", "does", "erinnere", "kann", "kannst", "mich",
    "mir", "please", "remember", "sag", "tell", "was", "what", "wie", "you",
}
_ACRONYMS = {
    "api": "application programming interface",
    "llm": "large language model",
    "mlx": "machine learning apple silicon",
    "rag": "retrieval augmented generation",
}


def refine_query(query: str) -> str:
    """Return one conservative content-focused query variant."""
    tokens = re.findall(r"[\wäöüß-]+", str(query or "").lower())
    refined = []
    for token in tokens:
        if token in _QUESTION_FILLERS:
            continue
        refined.extend(_ACRONYMS.get(token, token).split())
    return " ".join(refined).strip()
