"""Read-only workspace write status for maintenance and evening reviews."""
from datetime import datetime, timezone
import json
import logging
import re
from pathlib import Path
from zoneinfo import ZoneInfo
from .validation import resolve_inside


def collect_workspace_status(workspace, *, timezone_name=None, now=None):
    """Report file ages and queue counts without reading memory contents."""
    root = Path(workspace)
    if not root.is_dir():
        return None
    try:
        zone = ZoneInfo(timezone_name) if timezone_name else timezone.utc
    except (ValueError, KeyError):
        zone = timezone.utc
    moment = now or datetime.now(timezone.utc)
    today = moment.astimezone(zone).date()
    def stamp(parts):
        try:
            path = resolve_inside(root, *parts)
            if path.is_file():
                return datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)
        except (OSError, ValueError) as error:
            logging.getLogger(__name__).debug("workspace review path unavailable: %s", type(error).__name__)
        return None
    def newest(parts, pattern):
        try:
            folder = resolve_inside(root, *parts)
            if not folder.is_dir():
                return None
            candidates = [(item.name, stamp((*parts, item.name))) for item in folder.iterdir()
                          if re.fullmatch(pattern, item.name)]
            return max((item for item in candidates if item[1]), key=lambda item: item[1], default=None)
        except (OSError, ValueError) as error:
            logging.getLogger(__name__).debug("workspace review directory unavailable: %s", type(error).__name__)
            return None
    def info(value):
        return {"mtime": value.isoformat(), "ageDays": (today - value.astimezone(zone).date()).days}
    status = {}
    daily = newest(("memory",), r"\d{4}-\d{2}-\d{2}(?:-\d{4})?\.md")
    if daily:
        status["dailyNote"] = {**info(daily[1]), "date": daily[0][:10], "ok": daily[0][:10] == today.isoformat()}
    for key, subfolder in (("lightDream", "light"), ("remDream", "rem")):
        entry = newest(("memory", "dream-diary", subfolder), r".*\.md")
        if entry:
            status[key] = info(entry[1])
            if key == "remDream":
                status[key]["ok"] = status[key]["ageDays"] <= 8
    for key, parts in (("dreamDiary", ("DREAMS.md",)), ("memoryFile", ("MEMORY.md",)),
                       ("knowledge", ("memory", "KNOWLEDGE.md"))):
        value = stamp(parts)
        if value:
            status[key] = info(value)
    if "dreamDiary" in status and "remDream" in status:
        status["dreamDiary"]["withRem"] = True
        status["dreamDiary"]["ok"] = (
            datetime.fromisoformat(status["dreamDiary"]["mtime"]) -
            datetime.fromisoformat(status["remDream"]["mtime"])).total_seconds() >= -21600
    if "knowledge" in status:
        try:
            path = resolve_inside(root, ".adaptive-learning", "knowledge-pending.json")
            if path.is_file() and path.stat().st_size <= 8 * 1024 * 1024:
                pending = json.loads(path.read_text()).get("pending", [])
                if isinstance(pending, list):
                    status["knowledge"]["pending"] = len(pending)
                    status["knowledge"]["ok"] = not pending or status["knowledge"]["ageDays"] <= 8
        except (OSError, ValueError, AttributeError) as error:
            logging.getLogger(__name__).debug("workspace review queue unavailable: %s", type(error).__name__)
    return status or None
