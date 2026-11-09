import gzip
import json
from datetime import datetime, timezone

import pytest

from plur1bus_hermes import neo_retention


_NOW = int(datetime(2026, 11, 9, tzinfo=timezone.utc).timestamp() * 1000)
_OLD_SECONDS = _NOW // 1000 - 100 * 86400


def _line(identifier, *, timestamp=_OLD_SECONDS, **fields):
    return (json.dumps({"id": identifier, "timestamp": timestamp, "text": "same text", **fields}) + "\n").encode()


def test_retention_archives_old_weak_revisions_without_content_dedupe(tmp_path):
    journal = tmp_path / "memory-graph.jsonl"
    weak = [_line("weak", confidence=0.1), _line("weak", confidence=0.2)]
    protected = [
        _line("recent", timestamp=_NOW), _line("active", status="active", salience=0.7),
        _line("edge", source="s", target="t", type="rel", strength=0.8),
        _line("forever", neverForget=True), _line("pending", status="pending"),
    ]
    more_valuable = _line("other", status="candidate", salience=0.8)
    journal.write_bytes(b"".join([weak[0], *protected, more_valuable, weak[1]]))
    report = neo_retention.prune_journal(journal, soft=6, hard=40, days=90, now=_NOW)
    assert report == {"removedAge": 2, "removedHard": 0, "removedInjected": 0, "archived": 2}
    assert journal.read_bytes() == b"".join([*protected, more_valuable])
    archive = tmp_path / "archive" / "memory-graph.2026-11.jsonl.gz"
    assert gzip.decompress(archive.read_bytes()) == b"".join(weak)

    last = _line("edge-idless", source="a", target="b", type="rel", strength=0.1)
    graph_revision = last.replace(b'"id": "edge-idless", ', b"")
    journal.write_bytes(graph_revision + journal.read_bytes() + graph_revision)
    neo_retention.prune_journal(journal, soft=6, hard=40, days=90, now=_NOW)
    assert gzip.decompress(archive.read_bytes()) == b"".join(weak) + graph_revision * 2
    assert journal.read_bytes() == b"".join([*protected, more_valuable])


def test_archive_failure_does_not_rewrite_live_journal(tmp_path, monkeypatch):
    journal = tmp_path / "dream-diary.jsonl"
    original = _line("old") + _line("new", timestamp=_NOW)
    journal.write_bytes(original)

    def no_space(*args):
        raise OSError("fixture: archive unavailable")

    monkeypatch.setattr(neo_retention, "_archive", no_space)
    with pytest.raises(OSError, match="archive unavailable"):
        neo_retention.prune_journal(journal, soft=1, hard=40, days=90, now=_NOW)
    assert journal.read_bytes() == original


def test_emergency_cap_and_daily_sweep_of_hook_and_owner_stores(tmp_path, monkeypatch):
    monkeypatch.setenv("PLUR1BUS_NEO_MAX_RECORDS", "4")
    monkeypatch.setenv("PLUR1BUS_NEO_SOFT_MAX_RECORDS", "1")
    monkeypatch.setattr(neo_retention.time, "time", lambda: _NOW // 1000)
    retention = neo_retention.NeoRetention(tmp_path)
    hook, owner = tmp_path / "neo", tmp_path / "neo" / "private"
    recent = _line("recent", timestamp=_NOW)
    for root in (hook, owner):
        journal = root / "open-threads.jsonl"
        retention.append(journal, _line("protected", status="active", confidence=0.8))
        retention.append(journal, _line("old", confidence=0.2))
        retention.append(journal, _line("weak", confidence=0.1))
        retention.append(journal, recent)
        assert len(journal.read_bytes().splitlines()) == 4  # Append does not run age retention.
        retention.append(journal, _line("newer", timestamp=_NOW))
        assert b'"weak"' not in journal.read_bytes()
        (root / "turn-journal.jsonl").write_bytes(_line("byte-addressed") * 8)
        (root / "episodes.jsonl").write_bytes(_line("byte-addressed") * 8)
    report = retention.consolidate(hook, owner)
    assert report["hook"]["open-threads.jsonl"]["removedAge"] == 1
    assert report["owner"]["open-threads.jsonl"]["removedAge"] == 1
    for root in (hook, owner):
        assert len((root / "open-threads.jsonl").read_bytes().splitlines()) == 3
        assert (root / "turn-journal.jsonl").read_bytes() == _line("byte-addressed") * 8
        assert (root / "episodes.jsonl").read_bytes() == _line("byte-addressed") * 8
        archive = root / "archive" / "open-threads.2026-11.jsonl.gz"
        assert gzip.decompress(archive.read_bytes()) == _line("weak", confidence=0.1) + _line("old", confidence=0.2)
