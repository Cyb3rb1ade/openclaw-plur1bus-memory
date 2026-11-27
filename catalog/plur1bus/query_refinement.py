"""Bounded deterministic refinement for poor first-pass memory queries."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from html import unescape
import re
import unicodedata

from .valid_time import normalize_timestamp


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
    tokens = re.findall(r"[\wäöüß-]+", unicodedata.normalize("NFC", str(query or "")).lower())
    refined = []
    for token in tokens:
        if token in _QUESTION_FILLERS:
            continue
        refined.extend(_ACRONYMS.get(token, token).split())
    return " ".join(refined).strip()


_AUTO_RECALL_MAX_CHARS = 6_000
_ENVELOPE = re.compile(r"^\s*\[(?:audio transcript|voice transcript|transkript)[^\]\n]*\]:?\s*\"?", re.I)
_SPEAKER = re.compile(r"^[A-ZÄÖÜ][\w. -]{0,30}:\s+")
_TOKENS = re.compile(r"[^\W_]+", re.UNICODE)
_KEYWORD_FILLERS = _QUESTION_FILLERS | {
    "about", "after", "before", "could", "dann", "dass", "deine", "diese",
    "doch", "einen", "einer", "find", "from", "have", "here", "heute",
    "ihre", "jetzt", "more", "nach", "nicht", "noch", "oder", "said",
    "should", "that", "them", "then", "these", "this", "über", "want",
    "when", "where", "which", "with", "would", "your", "zeige",
}


def shorten_automatic_query(text: str) -> str:
    """Keep the opening subject and the final request without model work."""
    if len(text) <= _AUTO_RECALL_MAX_CHARS:
        return text
    separator = "\n…\n"
    room = _AUTO_RECALL_MAX_CHARS - len(separator)
    head = room // 3
    return text[:head] + separator + text[-(room - head):]


def _normalize_echo(text: str) -> str:
    value = _SPEAKER.sub("", _ENVELOPE.sub("", unescape(text)))
    return " ".join(_TOKENS.findall(unicodedata.normalize("NFKC", value).casefold()))


def query_echo_matcher(query: str):
    """Build a deterministic auto-recall echo check with bounded input."""
    query = _normalize_echo(query[:100_000])
    query_tokens = {word for word in query.split() if len(word) > 1}
    query_words = f" {query} "

    def matches(row) -> bool:
        if len(query) < 20:
            return False
        memory = _normalize_echo(str(row.get("content") or "")[:100_000])
        if len(memory) < 20:
            return False
        if memory == query:
            return True
        memory_words = f" {memory} "
        if memory_words in query_words and (row.get("chunkGroupId") or len(memory) >= 0.6 * len(query)):
            return True
        if query_words in memory_words and len(query) >= 0.8 * len(memory):
            return True
        memory_tokens = {word for word in memory.split() if len(word) > 1}
        return (min(len(query_tokens), len(memory_tokens)) >= 5
                and len(query_tokens & memory_tokens) / len(query_tokens | memory_tokens) >= 0.9)

    return matches


def fallback_keywords(query: str) -> list[str]:
    """Select up to six unique words containing only letters and digits."""
    value = unicodedata.normalize("NFC", query).lower()
    words = dict.fromkeys(
        token for token in _TOKENS.findall(value)
        if token.isalnum() and token not in _KEYWORD_FILLERS
        and len(token) <= 40
        and (len(token) >= 4 or (len(token) >= 2 and any(char.isdecimal() for char in token)))
    )
    return sorted(words, key=len, reverse=True)[:6]


def fallback_rank(row: dict, keywords: list[str], now_ms: int) -> tuple[float, int]:
    """Rank lexical matches before similarly recent non-matches."""
    content = str(row.get("content") or "").lower()
    matched = sum(word in content for word in keywords)
    created_at = normalize_timestamp(row.get("createdAt"))
    age_days = max(0, now_ms - created_at) / 86_400_000 if created_at else 365
    score = (0.05 if matched else 0) + (0.6 * matched / len(keywords) if keywords else 0)
    return score + 0.25 * 0.5 ** (age_days / 7), created_at


_RELATIVE_TIME = (
    r"\b(?:heute|gestern|today|yesterday|letzte\s+woche|last\s+week|"
    r"letzten?\s+monat|last\s+month|vor\s+\d{1,4}\s+(?:tagen?|stunden)|"
    r"\d{1,4}\s+(?:days?|hours?)\s+ago|(?:am|on)\s+(?:montag|dienstag|"
    r"mittwoch|donnerstag|freitag|samstag|sonntag|monday|tuesday|wednesday|"
    r"thursday|friday|saturday|sunday))\b"
)
_RELATIVE = re.compile(_RELATIVE_TIME, re.I)
_DURATION = re.compile(r"\b(?:seit|since|bis|until)\s+" + _RELATIVE_TIME, re.I)
_CLAUSE = re.compile(r"(?<=[.?!:])(?=\s|$)|[;,]|\n+")
_FUTURE = re.compile(r"\b(?:übermorgen|tomorrow|nächste[nrms]?|next\s+\w+|morgen)\b", re.I)
_NON_FUTURE_MORNING = re.compile(r"\b(?:heute|gestern|guten)\s+morgen\b", re.I)
_THIRD_PARTY = re.compile(
    r"\b(?:gehört|gesehen|gelesen|erfahren)\s*,?\s*(?:was|dass|wie|ob)\b"
    r"|\b(?:heard?|see|seen|read|learned)\s+(?:what|that|how|if)\b", re.I,
)
_OTHER_CONVERSATION = re.compile(
    r"\bmit\s+(?!dir\b|mir\b|uns\b)\S+[^.!?;,]{0,30}\b(?:gesprochen|telefoniert|geredet)\b"
    r"|\b(?:talked|spoke)\s+(?:to|with)\s+(?!you\b|me\b|us\b)", re.I,
)
_ABSOLUTE = re.compile(
    r"\b(?:20\d{2}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}\.20\d{2}"
    r"|Q[1-4]\s+20\d{2}|(?:of|in|im)\s+(?:January|Januar|February|Februar|March|März|"
    r"April|May|Mai|June|Juni|July|Juli|August|September|October|Oktober|November|December|Dezember))\b",
    re.I,
)
_DE_SPEECH = (
    r"(?:gesagt|geschrieben|erzählt|erzaehlt|geschickt|zugeschickt|gegeben|"
    r"empfohlen|vorgeschlagen|erklärt|erklaert|erwähnt|erwaehnt|gefragt|notiert|"
    r"versprochen|geschildert|gezeigt)"
)
_DE_CONVERSATION = (
    r"(?:besprochen|geredet|gesprochen|diskutiert|vereinbart|ausgemacht|"
    r"beschlossen|unterhalten|erledigt|festgelegt|geplant)"
)
_DE_QUERY = r"(?:was|worüber|worueber|worum|welche[nrs]?)"
_EN_SPEECH = r"(?:tell|told|say|said|mention(?:ed)?|send|sent|recommend(?:ed)?|write|wrote|ask(?:ed)?|show(?:ed)?)"
_GAP = r"[^\n.?!;,]{0,60}?"
_CONVERSATION_CUES = tuple(re.compile(pattern, re.I) for pattern in (
    rf"\b(?:ich|du)\b{_GAP}\b(?:dir|mir|uns)\b{_GAP}\b{_DE_SPEECH}\b",
    rf"\b(?:wir\s+(?:haben|hatten)|(?:haben|hatten)\s+wir)\b{_GAP}\b{_DE_CONVERSATION}\b",
    rf"\b(?:{_DE_QUERY}\s+)?(?:hast|hattest)\s+du\b{_GAP}\b(?:{_DE_SPEECH}|gemacht|erledigt|geprüft|gecheckt)\b",
    rf"\b(?:der\s+(?:nutzer|user|benutzer)|die\s+nutzerin)\b{_GAP}\b{_DE_SPEECH}\b",
    r"\b(?:dein(?:e|er|em|en)?|unser(?:e|er|em|en)?)\s+(?:chats?|gespräch(?:e|s)?|nachrichten?|antwort(?:en)?|zusammenfassung|liste)\b",
    r"\b(?:our|your)\s+(?:conversations?|chats?|messages?|answers?|summary)\b",
    rf"\b(?:what\s+did\s+(?:you|we|i|the user)\s+(?:{_EN_SPEECH}|discuss|talk|do|decide)|"
    rf"did\s+you\s+(?:send|write|say)|the\s+user\s+{_EN_SPEECH})\b",
    rf"\b(?:i|you)\s+{_EN_SPEECH}\b{_GAP}\b(?:you|me|us)\b",
))


def conversation_recall_range(query: str, *, now: datetime | None = None) -> dict[str, str] | None:
    """Use createdAt for unambiguous relative conversation time only."""
    from .cognition import parse_temporal_range

    if len(query) > 20_000:
        return None
    cleaned = _ENVELOPE.sub("", re.sub(r"```[\s\S]*?```", "", query))
    if len(" ".join(cleaned.split())) > 1500 or re.search(r"\b(?:nach dem|after the)\b", cleaned, re.I):
        return None
    reference = now or datetime.now(timezone.utc)
    if reference.tzinfo is None:
        reference = reference.replace(tzinfo=timezone.utc)
    for raw in _CLAUSE.split(cleaned):
        clause = _DURATION.sub("", raw)
        if (
            _FUTURE.search(_NON_FUTURE_MORNING.sub("", clause))
            or _THIRD_PARTY.search(clause) or _OTHER_CONVERSATION.search(clause)
            or _ABSOLUTE.search(clause)
        ):
            continue
        cues = [match.span() for pattern in _CONVERSATION_CUES for match in pattern.finditer(clause)]
        if not cues:
            continue
        ranges = {}
        for match in _RELATIVE.finditer(clause):
            if not any(match.start() <= end + 60 and start <= match.end() + 60 for start, end in cues):
                continue
            candidate = parse_temporal_range(match.group(), now=reference)
            if candidate:
                ranges[(candidate["start"], candidate["end"])] = candidate["source"]
        if len(ranges) == 1:
            (start, end), source = next(iter(ranges.items()))
            grace = timedelta(hours=2)
            return {
                "start": (datetime.fromisoformat(start) - grace).isoformat(),
                "end": min(reference, datetime.fromisoformat(end) + grace).isoformat(),
                "source": source,
            }
    return None
