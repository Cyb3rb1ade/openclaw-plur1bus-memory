"""Keep the original captured message ahead of redundant child fragments."""
from datetime import datetime, timezone
import re

from .valid_time import has_disjoint_validity_windows, normalize_timestamp


_RELATIVE_TIME_NOTE = (
    'RELATIVE TIME: Words inside a memory such as "yesterday", "last week", '
    '"next month", "gestern" or "letzte Woche" refer to its created-at time, '
    'not to today.'
)
_LIST_MARKER = re.compile(r"^[ \t]*(?:[-*•]|\d+[.)])[ \t]+", re.MULTILINE)


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
