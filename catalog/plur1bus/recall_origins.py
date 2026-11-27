"""Keep the original captured message ahead of redundant child fragments."""
from datetime import datetime, timezone
import math
import re

from .valid_time import has_disjoint_validity_windows, normalize_timestamp
from .validation import ValidationError, safe_memory_id


_RELATIVE_TIME_NOTE = (
    'RELATIVE TIME: Words inside a memory such as "yesterday", "last week", '
    '"next month", "gestern" or "letzte Woche" refer to its created-at time, '
    'not to today.'
)
_LIST_MARKER = re.compile(r"^[ \t]*(?:[-*•]|\d+[.)])[ \t]+", re.MULTILINE)
_MILLISECONDS_PER_DAY = 86_400_000
VOLATILE_STATE_NOTE = (
    "STATE AS OF: Words like aktuell/derzeit/läuft/live/latest/currently inside a record describe the "
    "state on its [Stand …] date (when the record was noted), not today. Do not present such a state "
    "as current without a live check."
)
_STATE_MARKER = re.compile(
    r"\b(?:aktuell(?:e[mnrs]?)?|derzeit(?:ig(?:e[mnrs]?)?)?|momentan(?:e[mnrs]?)?|"
    r"zurzeit|jetzt|gerade|läuft|laeuft|live|currently|now running|latest)\b", re.I,
)
_STATE_VALUE = re.compile(
    r"(?<![\w.])v?\d+(?:\.\d+){1,3}(?!\d)|"
    r"\b(?:claude|opus|sonnet|haiku|gpt|gemini|kimi|qwen|llama|mistral|deepseek|grok|glm|nemotron)(?![^\W\d_])", re.I,
)
_STATE_DATE = re.compile(
    r"(?<![\d.])(?:0?[1-9]|[12]\d|3[01])\.(?:0?[1-9]|1[0-2])\.(?:19|20)\d{2}(?!\d)|"
    r"(?<![\d.])(?:0?[1-9]|[12]\d|3[01])\.(?:0[1-9]|1[0-2])\.(?!\d)|"
    r"\b(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b|"
    r"\bStand\b|(?i:\bas of\b|\b\d{1,2}\.\s*(?:Januar|Februar|März|April|Mai|Juni|Juli|August|"
    r"September|Oktober|November|Dezember)\b|\b(?:January|February|March|April|May|June|July|"
    r"August|September|October|November|December)\s+\d{1,2}\b)",
)
_QUOTE = re.compile(r'„[^“”"\n]{0,400}[“”"]|"[^"\n]{0,400}"|«[^»\n]{0,400}»|»[^«\n]{0,400}«|“[^”\n]{0,400}”|`[^`\n]{0,400}`')


def _comparable_text(row):
    """Normalize whitespace and list markers, keeping all semantic text."""
    return " ".join(_LIST_MARKER.sub("", str(row.get("content") or "")).casefold().split())


def _origin(row):
    return (row.get("_namespace"), row.get("scopeKey"), row.get("sourceRole"),
            str(row.get("sourceTurnId") or "").strip())


def prefer_whole_rows(rows, hydrated=()):
    """Promote a proven same-scope original to its first matching child's rank."""
    originals = {}
    for row in (*rows, *hydrated):
        origin = _origin(row)
        if origin[-1] and not str(row.get("chunkGroupId") or "").strip():
            originals.setdefault(origin, []).append((row, _comparable_text(row)))
    result, emitted = [], set()
    for row in rows:
        origin = _origin(row)
        if origin[-1] and str(row.get("chunkGroupId") or "").strip():
            part = _comparable_text(row)
            if part:
                row = next((whole for whole, text in originals.get(origin, [])
                            if f" {part} " in f" {text} "
                            and not has_disjoint_validity_windows(whole, row)), row)
        marker = (row.get("_namespace"), row.get("id") or id(row))
        if marker not in emitted:
            emitted.add(marker)
            result.append(row)
    return result


def _turn_part_key(row):
    if (row.get("chunkGroupId") or row.get("type") == "dream" or row.get("memoryClass") == "dream"
            or row.get("sourceRole") not in {"user", "assistant"}):
        return None
    try:
        turn = safe_memory_id(row.get("sourceTurnId"))
    except ValidationError:
        return None
    origin = tuple(row.get(key) for key in ("_namespace", "agentId", "scopeKey", "sessionId", "sourceRole"))
    if not all(isinstance(value, str) and value for value in origin):
        return None
    observed = normalize_timestamp(row.get("versionCreatedAt")) or normalize_timestamp(row.get("createdAt"))
    if not observed:
        return None
    bindings = tuple(row.get(key) for key in ("scopeType", "ownerKey", "workspaceIdentity", "ownerPlatform", "ownerUser", "chatScope"))
    if not all(value is None or isinstance(value, str) for value in bindings):
        return None
    acl = row.get("aclBindings")
    if acl is not None and (not isinstance(acl, dict) or not all(isinstance(key, str) and isinstance(value, str)
                                                                for key, value in acl.items())):
        return None
    return (*origin, *bindings, tuple(sorted((acl or {}).items())), turn, observed // _MILLISECONDS_PER_DAY,
            normalize_timestamp(row.get("validFrom")), normalize_timestamp(row.get("validUntil")))


def merge_turn_parts(rows):
    """Fold a proven turn and speaker into its best-ranked prompt entry."""
    groups = {}
    for rank, row in enumerate(rows):
        key = _turn_part_key(row)
        if key is not None:
            groups.setdefault(key, []).append(rank)
    replacements, absorbed = {}, set()
    for ranks in groups.values():
        if len(ranks) < 2:
            continue
        parts = []
        for rank in sorted(ranks, key=lambda index: (normalize_timestamp(rows[index].get("createdAt")), index)):
            text = str(rows[rank].get("content") or "")
            comparable = " ".join(text.casefold().split())
            if comparable and not any(comparable in prior for _, prior in parts):
                parts = [(part, prior) for part, prior in parts if prior not in comparable]
                parts.append((text, comparable))
        content = "\n\n".join(text for text, _ in parts)
        if content and len(content) <= 60_000:
            replacements[ranks[0]] = dict(rows[ranks[0]], content=content)
            absorbed.update(ranks[1:])
    return [replacements.get(rank, row) for rank, row in enumerate(rows) if rank not in absorbed]


def annotate_volatile_state(text, row, now_ms, config):
    """Date old operational-state phrases in the prompt using capture time alone."""
    options = config if isinstance(config, dict) else {}
    if config is False or options.get("enabled") is False:
        return text, False
    observed = normalize_timestamp(row.get("versionCreatedAt")) or normalize_timestamp(row.get("createdAt"))
    age = options.get("minAgeDays", 2)
    if type(age) not in {int, float} or not 0 <= age < math.inf:
        age = 2
    if not observed or now_ms - observed < age * _MILLISECONDS_PER_DAY:
        return text, False
    cap = options.get("maxPerRecord", 2)
    cap = min(10, cap) if type(cap) is int and cap >= 1 else 2
    spans = iter(_QUOTE.finditer(text))
    span = next(spans, None)
    inserts = []
    last_end = -40
    for marker in _STATE_MARKER.finditer(text):
        start, end = marker.span()
        while span is not None and span.end() <= start:
            span = next(spans, None)
        if span is not None and span.start() <= start:
            continue
        if marker[0].lower() == "latest" and start and text[start - 1] in ":@/-_.":
            continue
        value = _STATE_VALUE.search(text, end, end + 70)
        if (end - last_end < 40 or value is None or value.start() - end > 30
                or _STATE_DATE.search(text[max(0, start - 60):end + 60])):
            continue
        inserts.append(end)
        last_end = end
        if len(inserts) >= cap:
            break
    if not inserts:
        return text, False
    date = datetime.fromtimestamp(observed / 1000, tz=timezone.utc).strftime("%d.%m.%Y")
    for end in reversed(inserts):
        text = text[:end] + f" [Stand {date}]" + text[end:]
    return text, True


def created_at_label(row) -> str:
    """Render only an actual capture timestamp, independent of claim validity."""
    stamp = normalize_timestamp(row.get("createdAt"))
    if not stamp:
        return ""
    try:
        return f'[created-at={datetime.fromtimestamp(stamp / 1000, tz=timezone.utc).isoformat()}]'
    except (OverflowError, OSError, ValueError):
        return ""


def relative_time_note() -> str:
    """Return the meaning of a memory record's relative dates."""
    return _RELATIVE_TIME_NOTE


def recall_text(row, position, full_text=False):
    """Top three hits stay complete; every shortened lower hit is labeled."""
    text = str(row.get("content") or "")
    if full_text or position < 3 or len(text) <= 2000:
        return text
    return text[:2000] + " [gekürzt]"
