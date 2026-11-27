"""Deterministic graph topics and a bounded append-aware journal edge index."""

from __future__ import annotations

import json
import math
import os
import re
import stat
import threading
from collections import Counter, OrderedDict, deque
from dataclasses import dataclass, field
from pathlib import Path

from .file_lock import open_existing
from .generation import _reject_symlink_components


_TOPIC = re.compile(r"\b[A-ZÄÖÜ][A-Za-zÄÖÜäöüß]+(?:[ \t]+[A-ZÄÖÜ][A-Za-zÄÖÜäöüß]+)*\b")
_STOPWORDS = frozenset("""der die das den dem ein eine einer einem einen ich du er sie es wir ihr mich
    dich ihn und oder aber denn weil wenn dass mit für von zu auf in an bei nach aus über unter vor
    hinter neben zwischen durch gegen ohne um bis ist sind war waren wird werden wurde wurden habe hat
    hatten hatte kann können konnte konnten muss müssen musste mussten will wollen wollte soll sollen
    sollte sollten darf dürfen durfte mag mögen mochte this that the and are was were been being have
    has had does did will would could should may might must can shall they you him her them your his
    its our their who which what where when how why whose whom""".split())
_MAX_JOURNALS = 8
_MAX_LINES = 10_000
_MAX_BYTES = 4 * 1024 * 1024
_MAX_LINE_BYTES = 65_536
_ANCHOR_BYTES = 256


def graph_topics(text: str) -> frozenset[str]:
    """Derive at most ten name/topic signals without adding new emotion evidence."""
    topics = set()
    for match in _TOPIC.finditer(text[:12_000]):
        topic = ' '.join(match.group().casefold().split())
        if len(topic) > 2 and topic not in _STOPWORDS:
            topics.add(topic)
            if len(topics) >= 10:
                break
    return frozenset(topics)


def entity_strength(source: frozenset[str], target: frozenset[str]) -> float:
    """Use distinct topic overlap and the upstream Jaccard threshold."""
    shared = len(source & target)
    if shared < 2:
        return 0.0
    overlap = shared / len(source | target)
    return min(0.7, 0.8 * overlap) if overlap >= 0.5 else 0.0


def edge_key(edge: dict) -> tuple | None:
    """Return a scope-bound key, canonical for undirected edges."""
    agent, scope, kind, source, target = (edge.get(name) for name in (
        'agentId', 'scopeKey', 'type', 'source', 'target',
    ))
    if not all(isinstance(value, str) and value for value in (agent, scope, kind, source, target)):
        return None
    directed = edge.get('directed') is True
    if not directed and target < source:
        source, target = target, source
    return agent, scope, kind, directed, source, target


def _parse_edge(line: bytes) -> dict | None:
    if len(line) > _MAX_LINE_BYTES:
        return None
    try:
        row = json.loads(line)
    except (ValueError, UnicodeError, RecursionError):
        return None
    if not isinstance(row, dict):
        return None
    scope = row.get('scopeKey')
    if not scope and isinstance(bindings := row.get('aclBindings'), dict):
        scope = bindings.get('scopeKey') or bindings.get('key')
    source, target = row.get('source'), row.get('target')
    if not all(isinstance(value, str) and 0 < len(value) <= 512 for value in (source, target)):
        return None
    agent, kind = row.get('agentId'), row.get('type')
    if any(value is not None and (not isinstance(value, str) or len(value) > 512)
           for value in (scope, agent, kind)):
        return None
    try:
        strength = float(row.get('strength', 0))
    except (TypeError, ValueError, OverflowError):
        strength = 0.0
    return {'source': source, 'target': target, 'scopeKey': scope, 'agentId': agent, 'type': kind,
            'directed': bool(row.get('directed')),
            'strength': strength if math.isfinite(strength) else 0.0}


@dataclass
class _Tail:
    signature: tuple = ()
    offset: int = 0
    head: bytes = b''
    anchor: bytes = b''
    rows: deque = field(default_factory=deque)
    counts: Counter = field(default_factory=Counter)

    def add(self, edge):
        self.rows.append(edge)
        if edge is not None and (key := edge_key(edge)) is not None:
            self.counts[key] += 1
        if len(self.rows) > _MAX_LINES:
            removed = self.rows.popleft()
            if removed is not None and (key := edge_key(removed)) is not None:
                self.counts[key] -= 1
                if not self.counts[key]:
                    del self.counts[key]


def _read_at(stream, offset: int, length: int) -> bytes:
    stream.seek(offset)
    return stream.read(length)


class EdgeJournalIndex:
    """Keep only the recent graph window; capture callers hold the writer lock."""

    def __init__(self, root: Path):
        self._root = root
        self._lock = threading.Lock()
        self._tails = OrderedDict()

    def _read(self, path: Path) -> _Tail:
        _reject_symlink_components(self._root, path, message='unsafe graph journal path')
        try:
            descriptor = open_existing(path)
        except FileNotFoundError:
            self._tails.pop(path, None)
            return _Tail()
        with os.fdopen(descriptor, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode):
                raise OSError('graph journal is not a regular file')
            signature = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
            previous = self._tails.pop(path, None)
            if previous is not None and previous.signature == signature:
                self._tails[path] = previous
                return previous
            appended = (previous is not None and previous.signature[:2] == signature[:2]
                        and previous.signature[2] < info.st_size
                        and info.st_size - previous.offset <= _MAX_BYTES
                        and _read_at(stream, 0, len(previous.head)) == previous.head
                        and _read_at(stream, previous.offset - len(previous.anchor), len(previous.anchor)) == previous.anchor)
            tail = previous if appended else _Tail()
            start = tail.offset if appended else max(0, info.st_size - _MAX_BYTES)
            payload = _read_at(stream, start, info.st_size - start)
            if len(payload) != info.st_size - start:
                raise OSError('graph journal changed during read')
            complete = payload.rfind(b'\n') + 1
            lines = payload[:complete].split(b'\n')[:-1]
            if not appended and start and _read_at(stream, start - 1, 1) != b'\n':
                lines = lines[1:]  # The cold bounded tail starts inside a line.
            for line in lines[-_MAX_LINES:]:
                tail.add(_parse_edge(line))
            if complete or not appended:
                tail.offset = start + complete
            tail.head = _read_at(stream, 0, min(info.st_size, _ANCHOR_BYTES))
            anchor = min(tail.offset, _ANCHOR_BYTES)
            tail.anchor = _read_at(stream, tail.offset - anchor, anchor)
            tail.signature = signature
            self._tails[path] = tail
            if len(self._tails) > _MAX_JOURNALS:
                self._tails.popitem(last=False)
            return tail

    def existing(self, path: Path, candidates: set[tuple]) -> set[tuple]:
        """Return only supplied keys present in the scoped journal window."""
        with self._lock:
            return candidates.intersection(self._read(path).counts)

    def adjacent(self, path: Path, ids: set[str]) -> list[dict]:
        """Return recent candidate edges incident on the supplied seed IDs."""
        with self._lock:
            return [row for row in self._read(path).rows if row is not None and (
                row['source'] in ids or (not row['directed'] and row['target'] in ids)
            )]
