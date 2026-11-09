"""Keep the original captured message ahead of redundant child fragments."""
from .valid_time import has_disjoint_validity_windows


def prefer_whole_rows(rows):
    """Promote a same-turn original to its first child's ranked position."""
    originals = {}
    for row in rows:
        turn = str(row.get("sourceTurnId") or "").strip()
        if turn and not str(row.get("chunkGroupId") or "").strip():
            originals.setdefault(turn, []).append(row)
    result, emitted = [], set()
    for row in rows:
        turn = str(row.get("sourceTurnId") or "").strip()
        if turn and str(row.get("chunkGroupId") or "").strip():
            row = next((whole for whole in originals.get(turn, [])
                        if not has_disjoint_validity_windows(whole, row)), row)
        marker = id(row)
        if marker not in emitted:
            emitted.add(marker)
            result.append(row)
    return result


def recall_text(row, position, full_text=False):
    """Top three hits stay complete; every shortened lower hit is labeled."""
    text = str(row.get("content") or "")
    if full_text or position < 3 or len(text) <= 2000:
        return text
    return text[:2000] + " [gekürzt]"
