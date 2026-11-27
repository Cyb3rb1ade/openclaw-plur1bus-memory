"""Scoped cross-run graph candidates and a bounded, rewrite-safe edge journal."""

import json
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4

import lancedb

from plur1bus_hermes.domain import Plur1busDomain
from plur1bus_hermes.graph_edges import EdgeJournalIndex, edge_key
from plur1bus_hermes.namespaces import binding_from_scope
from plur1bus_hermes.neo_retention import prune_journal
from plur1bus_hermes.writer_lock import writer_lock


def row(scope, text, created='2026-11-20T00:00:00+00:00', **values):
    return {
        'id': str(uuid4()), 'agentId': scope.agent_id, 'scopeKey': scope.scope_key,
        'ownerPlatform': scope.platform, 'ownerUser': scope.user_id,
        'content': text, 'status': 'active', 'vector': [9.0, 9.0], 'expiresAt': 0,
        'epistemicStatus': 'observed', 'createdAt': created, 'sessionId': 'older-session',
        **values,
    }


def test_entity_link_across_sessions_never_reads_outside_owner_or_lifecycle(tmp_path):
    owner = binding_from_scope('main', {'scopeType': 'user', 'platform': 'cli', 'userId': 'owner'})
    other = binding_from_scope('main', {'scopeType': 'user', 'platform': 'cli', 'userId': 'other'})
    source = row(owner, 'Andrew and Toby renovated Riverside Shelter near London.',
                 vector=[0.0, 0.1], sessionId='newer-session')
    old = row(owner, 'Andrew and Toby visited Riverside Shelter near London.')
    excluded = [
        row(other, old['content']), row(owner, old['content'], agentId='foreign-agent'),
        row(owner, old['content'], status='archived'), row(owner, old['content'], expiresAt=1),
        row(owner, old['content'], epistemicStatus='  INVALIDATED  '),
    ]
    table = lancedb.connect(str(tmp_path / 'db')).create_table('memories', [old, *excluded, source])
    domain = Plur1busDomain(tmp_path, 'main')
    other_runtime = Plur1busDomain(tmp_path, 'main')
    owner_record = {**source, 'scopeType': owner.scope_type, 'aclBindings': owner.as_dict()}
    scoped_root = domain._scope_neo_dir(domain._scope_selector(acl_bindings=owner.as_dict()))
    ready = Barrier(2, timeout=5)

    def build(runtime):
        ready.wait()
        runtime._build_graph_edges(owner_record, table)

    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(build, domain)
        # A separately constructed scope runtime starts with a cold edge index.
        second = executor.submit(build, other_runtime)
        first.result(timeout=10)
        second.result(timeout=10)
    edges = domain._read_jsonl(scoped_root / 'memory-graph.jsonl')
    assert [(edge['source'], edge['target'], edge['type']) for edge in edges] == [
        (source['id'], old['id'], 'entity'),
    ]
    assert domain._graph_neighbor_ids({source['id']}, acl_bindings=owner.as_dict()) == {old['id']}
    assert domain._graph_neighbor_ids({source['id']}, acl_bindings=other.as_dict()) == set()


def test_graph_projection_limits_the_newest_rows_after_scope_filter(tmp_path):
    owner = binding_from_scope('main')
    text = 'Andrew and Toby visited Riverside Shelter near London.'
    old = row(owner, text, created='2020-01-01T00:00:00+00:00')
    fill = [row(owner, 'Unrelated orchard produce was priced monthly.') for _ in range(110)]
    latest = row(owner, text, created='2026-11-25T00:00:00+00:00')
    source = row(owner, text + ' The renovations began.', created='2026-11-26T00:00:00+00:00', vector=[0.0, 0.1])
    table = lancedb.connect(str(tmp_path / 'db')).create_table('memories', [old, *fill, latest, source])
    domain = Plur1busDomain(tmp_path, 'main')
    domain._build_graph_edges(source, table)
    edges = domain._read_jsonl(domain.neo_dir / 'memory-graph.jsonl')
    assert [(edge['target'], edge['type']) for edge in edges] == [(latest['id'], 'entity')]


def journal_edge(agent, source, target):
    return {'agentId': agent, 'scopeKey': 'scope', 'source': source, 'target': target,
            'type': 'entity', 'strength': 0.6, 'directed': False, 'createdAt': '2020-01-01T00:00:00+00:00'}


def test_existence_index_tracks_appends_partial_lines_and_retention_rewrite(tmp_path):
    journal = tmp_path / 'memory-graph.jsonl'
    old = journal_edge('a', 'first', 'second')
    newer = journal_edge('a', 'third', 'first')
    index = EdgeJournalIndex(tmp_path)
    journal.write_text(json.dumps(old) + '\n', encoding='utf-8')
    forward, backward = edge_key(old), edge_key({**old, 'source': 'second', 'target': 'first'})
    assert forward == backward
    newer_key = edge_key(newer)
    assert index.existing(journal, {backward, newer_key}) == {forward}
    encoded = json.dumps(newer).encode('utf-8')
    with journal.open('ab') as stream:
        stream.write(encoded[:12])
    assert index.existing(journal, {backward, newer_key}) == {forward}
    with journal.open('ab') as stream:
        stream.write(encoded[12:] + b'\n')
    assert index.existing(journal, {backward, newer_key}) == {forward, newer_key}
    with writer_lock(tmp_path):
        report = prune_journal(journal, soft=1, hard=1, days=90, root=tmp_path)
    assert report['archived'] == 1
    assert index.existing(journal, {backward, newer_key}) == {newer_key}


def test_existence_index_reads_only_the_bounded_tail_and_appended_bytes(tmp_path, monkeypatch):
    from plur1bus_hermes import graph_edges

    monkeypatch.setattr(graph_edges, '_MAX_BYTES', 1_024)
    journal = tmp_path / 'memory-graph.jsonl'
    history = [journal_edge('a', 'seed', f'other-{i}') for i in range(100)]
    journal.write_text(''.join(json.dumps(edge) + '\n' for edge in history), encoding='utf-8')
    reads = []
    read_at = graph_edges._read_at

    def track(stream, offset, length):
        reads.append((offset, length))
        return read_at(stream, offset, length)

    monkeypatch.setattr(graph_edges, '_read_at', track)
    index = EdgeJournalIndex(tmp_path)
    first, last = edge_key(history[0]), edge_key(history[-1])
    assert index.existing(journal, {first, last}) == {last}
    assert max(length for _offset, length in reads) == 1_024
    previous_size = journal.stat().st_size
    pending = journal_edge('a', 'seed', 'added')
    with journal.open('a', encoding='utf-8') as stream:
        stream.write(json.dumps(pending) + '\n')
    reads.clear()
    assert index.existing(journal, {edge_key(pending), last}) == {edge_key(pending), last}
    assert (previous_size, journal.stat().st_size - previous_size) in reads
    assert max(length for _offset, length in reads) <= 256
