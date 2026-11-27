"""Vector-space routing uses real staged LanceDB stores and fake encoders."""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from threading import Event
from time import monotonic
from uuid import uuid4

import lancedb
import pytest

from plur1bus_hermes.generation import activate_staged_generation
from plur1bus_hermes.namespaces import binding_from_scope, resolve_namespace_routes
from plur1bus_hermes.recall_identities import RecallIdentityRouter, fuse_recall_identities
from plur1bus_hermes.reembed_staged import apply_staged_reembed, plan_staged_reembed
from plur1bus_hermes.runtime import EmbeddingBackend, Plur1busRuntime


class StagedEncoder:
    def __init__(self, config, *_args):
        self.width = config['dimensions']

    def embed(self, _text):
        return [0.0] * self.width

    def close(self):
        pass


@pytest.fixture
def stores(tmp_path, monkeypatch):
    scope = binding_from_scope('a', {'scopeType': 'user', 'platform': 'cli', 'userId': 'author'})
    scoped = scope.as_dict()
    configs = {
        'writer': {'provider': 'local-transformers', 'model': 'test/writer', 'dimensions': 2},
        'archive': {'provider': 'openai-compatible', 'model': 'test/archive', 'dimensions': 3,
                    'baseUrl': 'https://example.invalid/v1', 'apiKeyEnv': 'ARCHIVE_KEY',
                    'cleanText': {'enabled': True, 'stripSpeaker': True}},
    }
    target_paths = {}
    for namespace, embedding in configs.items():
        config = {'embedding': embedding, 'namespaces': {
            'activeWriteNamespace': namespace, 'activeRecallNamespaces': [namespace],
        }}
        seed = Plur1busRuntime(tmp_path, {**config, 'embedding': {'dimensions': 1}}, 'a', scope=scoped)
        try:
            seed._embedding.embed = lambda *_args, **_kwargs: [1.0]
            seed._domain.on_memory = lambda *_args, **_kwargs: None
            seed._remember(f'Memory belonging to the {namespace} scope.', 'old-session', 'user')
            table, _ = seed._table(create=False)
            card, = table.search().limit(1).to_list()
            table.add([{**card, 'id': str(uuid4()), 'scopeKey': 'unrelated',
                        'content': 'Foreign secret must stay hidden.'}])
        finally:
            seed.shutdown()
        plan = plan_staged_reembed(tmp_path, 'a', config)
        apply_staged_reembed(plan, tmp_path, 'a', config, backend_factory=StagedEncoder)
        activate_staged_generation(plan, tmp_path, 'a', config, approved_plan_id=plan['planId'])
        target_paths[namespace] = plan['targetRoute']

    calls = []

    def embed(self, text, *, purpose='passage'):
        calls.append((self.config['model'], text, purpose))
        return [0.1] * self.config['dimensions']

    monkeypatch.setattr(EmbeddingBackend, 'embed', embed)
    config = {'embedding': configs['writer'], 'namespaces': {
        'activeWriteNamespace': 'writer', 'activeRecallNamespaces': ['writer', 'archive'],
        'recallEmbeddings': {'archive': configs['archive']},
    }, 'recall': {'queryRefinement': False}}
    return tmp_path, config, scoped, calls, target_paths


def test_real_multi_space_recall_is_scoped_and_uses_pinned_encoders(stores):
    root, config, scope, calls, paths = stores
    writer, routes = resolve_namespace_routes(root, 'a', config)
    assert str(writer.path) == paths['writer']
    assert [(route.name, route.writable, route.embedding_dimensions) for route in routes] == [
        ('writer', True, 2), ('archive', False, 3),
    ]
    assert len({route.embedding_fingerprint for route in routes}) == 2
    # The staged writer remains authoritative when the general profile config
    # names another (possibly coincidentally same-width) model.
    config = {**config, 'embedding': {'provider': 'local-transformers', 'model': 'wrong', 'dimensions': 2}}
    runtime = Plur1busRuntime(root, config, 'a', scope=scope)
    try:
        answer = runtime.recall('Speaker: find the stored detail', automatic=True)
    finally:
        runtime.shutdown()
    assert 'writer scope' in answer and 'archive scope' in answer
    assert 'Foreign secret' not in answer
    assert sorted(calls) == [('test/archive', 'find the stored detail', 'query'),
                             ('test/writer', 'Speaker: find the stored detail', 'query')]


@pytest.mark.parametrize('override', ['missing', 'different-endpoint'])
def test_read_route_never_admits_unapproved_remote_provider(stores, override):
    root, config, scope, calls, _paths = stores
    config = deepcopy(config)
    approved = config['namespaces']['recallEmbeddings']
    if override == 'missing':
        approved.clear()
    else:
        approved['archive']['baseUrl'] = 'https://different.invalid/v1'
    runtime = Plur1busRuntime(root, config, 'a', scope=scope)
    try:
        answer = runtime.recall('find the stored detail')
    finally:
        runtime.shutdown()
    assert 'writer scope' in answer and 'archive scope' not in answer
    assert [call[0] for call in calls] == ['test/writer']


def test_rank_fusion_compares_only_ranks_and_one_vote_per_identity():
    def row(ident, name, distance):
        return {'_embeddingIdentity': ident, 'id': name, 'agentId': 'a', 'scopeKey': 'person',
                'content': f'Fact {name}', '_distance': distance}

    rows = [row('a', 'only-a', 0.001), row('a', 'joint', 0.2), row('a', 'only-a', 0.002),
            row('b', 'only-b', 100.0), row('b', 'joint', 150.0)]
    fused = fuse_recall_identities(rows)
    assert [item['id'] for item in fused] == ['joint', 'only-a', 'only-b']
    assert all('_distance' not in item for item in fused)
    assert fused[0]['rrfScore'] == 2 / 62
    assert fused[1]['rrfScore'] == 1 / 61
    single_identity = rows[:3]
    assert fuse_recall_identities(single_identity) is single_identity
    surviving_secondary = fuse_recall_identities(rows[3:], primary_identity='a')
    assert [item['id'] for item in surviving_secondary] == ['only-b', 'joint']
    assert all('_distance' not in item for item in surviving_secondary)


def test_losing_writer_embedding_does_not_query_another_space_with_wrong_vector(stores, monkeypatch):
    root, config, scope, calls, _paths = stores
    embed = EmbeddingBackend.embed

    def available(self, query, *, purpose):
        if self.config['model'] == 'test/writer':
            raise TimeoutError('writer offline')
        return embed(self, query, purpose=purpose)

    monkeypatch.setattr(EmbeddingBackend, 'embed', available)
    runtime = Plur1busRuntime(root, config, 'a', scope=scope)
    try:
        answer = runtime.recall('find our memory')
    finally:
        runtime.shutdown()
    assert 'archive scope' in answer
    assert 'writer scope' not in answer
    assert [call[0] for call in calls] == ['test/archive']


def test_capture_only_mutates_the_active_writer(stores):
    root, config, scope, calls, paths = stores
    runtime = Plur1busRuntime(root, config, 'a', scope=scope)
    try:
        runtime._domain.on_memory = lambda *_args, **_kwargs: None
        runtime._remember('A new approved fact from the local owner', 'session', 'user')
    finally:
        runtime.shutdown()
    counts = {
        namespace: lancedb.connect(str(path)).open_table('memories').count_rows()
        for namespace, path in paths.items()
    }
    assert counts == {'writer': 3, 'archive': 2}
    assert [call[0] for call in calls] == ['test/writer']


def test_all_unavailable_uses_scoped_lexical_fallback(stores, monkeypatch):
    root, config, scope, _calls, _paths = stores

    def unavailable(self, _query, *, purpose):
        if self.config['model'] == 'test/writer':
            raise TimeoutError('writer offline')
        return [0.5]  # A mismatched-width response must be discarded before a read.

    monkeypatch.setattr(EmbeddingBackend, 'embed', unavailable)
    runtime = Plur1busRuntime(root, config, 'a', scope=scope)
    try:
        found = runtime.recall('Find writer and archive scope memories', automatic=True)
    finally:
        runtime.shutdown()
    assert 'retrieval="keyword-recent-fallback"' in found
    assert 'writer scope' in found and 'archive scope' in found
    assert 'Foreign secret' not in found


def test_one_deadline_keeps_fast_identity_and_skips_slow_secondary(stores):
    root, config, _scope, _calls, _paths = stores
    writer, routes = resolve_namespace_routes(root, 'a', config)
    entered, unblock = Event(), Event()

    class BlockingArchive:
        def embed(self, _text, *, purpose):
            assert purpose == 'query'
            entered.set()
            assert unblock.wait(5)
            return [0.2, 0.2, 0.2]

        def close(self):
            pass

    with ThreadPoolExecutor(max_workers=2) as pool:
        router = RecallIdentityRouter(writer, routes, config, lambda _embedding: BlockingArchive())
        try:
            fast = EmbeddingBackend(config['embedding'], root)
            started = monotonic()
            vectors = router.query_vectors('query', 'query', fast, pool.submit, started + 0.2)
            assert entered.is_set()
            assert monotonic() - started < 1.0
            assert vectors == {writer.embedding_fingerprint: [0.1, 0.1]}
        finally:
            unblock.set()
            pool.shutdown(wait=True)
            fast.close()
            router.close()
