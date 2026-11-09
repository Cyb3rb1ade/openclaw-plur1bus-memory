"""Keep recent Neo journal history and archive the lowest-value old revisions."""

from __future__ import annotations

import gzip
import json
import logging
import math
import os
import shutil
import tempfile
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from .file_io import replace_file, sync_parent
from .generation import _reject_symlink_components
from .inject_markers import is_injected_context_text
from .valid_time import normalize_timestamp
from .writer_lock import writer_lock

# Capture receipts address exact byte ranges in turn-journal and episodes.
# Dispatch and destructive-operation ledgers also have independent contracts.
JOURNALS = frozenset({
    "contradiction-disclosure.jsonl", "dream-diary.jsonl", "dream-echo.jsonl",
    "emotional-state.jsonl", "episode-narratives.jsonl", "light-dreams.jsonl",
    "memory-cognition.jsonl", "memory-graph.jsonl", "open-threads.jsonl",
    "pending-reminder-proposals.jsonl",
})
_RANK = {"promoted": 3, "active": 2, "candidate": 1, "pending": 1,
         "conflict": 0, "demoted": 0, "pruned": 0, "tombstoned": 0}
_TIMES = ("updatedAt", "lastReinforcedAt", "endTime", "startTime", "createdAt",
          "timestamp", "extractedAt", "processedAt", "queuedAt")
_LOG = logging.getLogger(__name__)


def _limit(name: str, default: int) -> int:
    try:
        return max(1, int(os.getenv(name, str(default))))
    except ValueError:
        return default


def _record(line: bytes) -> dict:
    try:
        item = json.loads(line)
    except (ValueError, UnicodeError):
        return {}
    return item if isinstance(item, dict) else {}


def _timestamp(record: dict) -> float:
    stamps = []
    for key in _TIMES:
        value = record.get(key)
        if type(value) in (int, float):
            if not 0 < value < 253_402_300_800_000:
                continue
            if value < 1e12:
                value *= 1000  # Older journal events can use epoch seconds.
        if stamp := normalize_timestamp(value):
            stamps.append(stamp)
    return max(stamps, default=math.inf)


def _number(value, default=0.0):
    return value if type(value) in (int, float) and 0 <= value <= 1 else default


def _key(record, index):
    scope = str(record.get("scopeKey") or "")
    if record.get("id") is not None:
        return scope, "id", str(record["id"])
    if record.get("source") is not None and record.get("target") is not None:
        return scope, "edge", str(record["source"]), str(record["target"]), str(record.get("type") or "")
    return scope, "line", index


@dataclass
class _Group:
    indexes: list[int] = field(default_factory=list)
    time: float = -math.inf
    latest: dict = field(default_factory=dict)

    @property
    def protected(self):
        row = self.latest
        status = row.get("status")
        if row.get("neverForget") is True or status == "pending":
            return True
        if status in ("active", "promoted"):
            return max(_number(row.get("salience")), _number(row.get("confidence"))) >= 0.6
        return row.get("source") is not None and row.get("target") is not None and _number(row.get("strength")) >= 0.6

    @property
    def weakest(self):
        row = self.latest
        weight = row.get("salience", row.get("strength"))
        score = _RANK.get(str(row.get("status")), 1) + _number(weight, 0.5) + _number(row.get("confidence"), 0.5)
        return score, self.time, self.indexes[0]


def _selection(records, *, soft, hard, cutoff):
    groups = {}
    for index, record in enumerate(records):
        group = groups.setdefault(_key(record, index), _Group())
        group.indexes.append(index)
        stamp = _timestamp(record)
        if stamp >= group.time:
            group.latest = record
            group.time = stamp

    order = sorted(groups.values(), key=lambda group: (group.protected, group.weakest))
    remaining = len(records)
    removed = {}
    for group in order:
        if remaining <= soft or group.protected:
            break
        if group.time < cutoff:
            removed.update(dict.fromkeys(group.indexes, "removedAge"))
            remaining -= len(group.indexes)
    # Under emergency pressure, exhaust weak groups before dropping the oldest protected ones.
    protected = sorted((group for group in order if group.protected), key=lambda group: (group.time, group.indexes[0]))
    for group in [*(group for group in order if not group.protected), *protected]:
        if remaining <= hard:
            break
        if group.indexes[0] not in removed:
            removed.update(dict.fromkeys(group.indexes, "removedHard"))
            remaining -= len(group.indexes)
    return removed


def _publish(path: Path, write) -> None:
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".neo-", delete=False) as handle:
        temporary = Path(handle.name)
        try:
            write(handle)
            handle.flush()
            os.fsync(handle.fileno())
            handle.close()
            replace_file(temporary, path)
            sync_parent(path)
        finally:
            handle.close()
            temporary.unlink(missing_ok=True)


def _archive(root: Path, path: Path, lines: list[bytes], now: float) -> None:
    month = datetime.fromtimestamp(now / 1000, tz=timezone.utc).strftime("%Y-%m")
    target = path.parent / "archive" / f"{path.stem}.{month}.jsonl.gz"
    _check_path(root, target)
    target.parent.mkdir(exist_ok=True, mode=0o700)

    def write(handle):
        if target.exists():
            with target.open("rb") as previous:
                shutil.copyfileobj(previous, handle)
        with gzip.GzipFile(filename="", fileobj=handle, mode="wb", mtime=0) as archive:
            archive.writelines(lines)

    _publish(target, write)


def _check_path(root: Path, path: Path) -> None:
    _reject_symlink_components(root, path, message="Neo journal path escapes its data directory")


def prune_journal(path: Path, *, soft: int, hard: int, days: int, now=None, clean_injected=True, root=None) -> dict:
    """Archive before rewriting. Call with the same writer lease as append."""
    report = dict(removedInjected=0, removedAge=0, removedHard=0, archived=0)
    root = path.parent if root is None else root
    _check_path(root, path)
    if not path.is_file():
        return report
    now = int(time.time() * 1000) if now is None else now
    lines = path.read_bytes().splitlines(keepends=True)
    kept, discarded, records = [], set(), []
    for index, line in enumerate(lines):
        record = _record(line)
        text = next((record[k] for k in ("statement", "content", "text", "summary") if isinstance(record.get(k), str)), "")
        if clean_injected and is_injected_context_text(text):
            report["removedInjected"] += 1
            discarded.add(index)
        else:
            kept.append(index)
            records.append(record)
    if len(kept) > min(soft, hard):
        removed = _selection(records, soft=soft, hard=hard, cutoff=now - days * 86_400_000)
        for index, reason in removed.items():
            report[reason] += 1
            discarded.add(kept[index])
    if discarded:
        removed_lines = [lines[index] for index in sorted(discarded)]
        _archive(root, path, [line if line.endswith(b"\n") else line + b"\n" for line in removed_lines], now)
        _publish(path, lambda handle: handle.writelines(
            line for index, line in enumerate(lines) if index not in discarded
        ))
        report["archived"] = len(discarded)
    return report


class NeoRetention:
    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        self.hard = _limit("PLUR1BUS_NEO_MAX_RECORDS", 40_000)
        self.soft = _limit("PLUR1BUS_NEO_SOFT_MAX_RECORDS", 5000)
        self.days = _limit("PLUR1BUS_NEO_RETENTION_DAYS", 90)
        self._counts = {}

    def append(self, path: Path, record: bytes) -> None:
        with writer_lock(self.data_dir):
            _check_path(self.data_dir, path)
            path.parent.mkdir(parents=True, exist_ok=True)
            count = self._count(path)
            with path.open("ab") as handle:
                handle.write(record)
            self._counts[path] = (path.stat(), count + 1)
            if count + 1 > self.hard:
                self._prune(path, soft=self.hard, clean_injected=False)

    def _count(self, path):
        if not path.exists():
            return 0
        current = path.stat()
        previous, count = self._counts.get(path, (None, 0))
        with path.open("rb") as handle:
            if (previous and (previous.st_dev, previous.st_ino) == (current.st_dev, current.st_ino)
                    and current.st_size > previous.st_size):
                handle.seek(previous.st_size)
            elif previous and current == previous:
                return count
            else:
                count = 0
            return count + sum(1 for _ in handle)

    def _prune(self, path, *, soft, clean_injected):
        try:
            return prune_journal(path, soft=soft, hard=self.hard, days=self.days, clean_injected=clean_injected, root=self.data_dir)
        except (OSError, ValueError) as error:
            _LOG.warning("Neo journal retention deferred (%s)", type(error).__name__)
            return {"failed": True}
        finally:
            self._counts.pop(path, None)

    def consolidate(self, root: Path, owner: Path) -> dict:
        """Sweep the real capture store and the current owner, once per directory."""
        with writer_lock(self.data_dir):
            return {
                scope: {name: self._prune(directory / name, soft=self.soft, clean_injected=True)
                        for name in sorted(JOURNALS) if (directory / name).is_file()}
                for scope, directory in (("hook", root), ("owner", owner))
                if scope == "hook" or owner != root
            }
