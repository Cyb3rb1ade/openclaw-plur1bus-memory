"""Real Lance pools admit only certified ANN and scope-bound lexical results."""

from uuid import uuid4

import lancedb
import pytest

from plur1bus_hermes.shared_pools import SharedPoolStore, SharedPrincipal


PRIMARY = 'a' * 64
SAME_WIDTH = 'b' * 64
DIFFERENT_WIDTH = 'c' * 64


def card(text, width=2, **values):
    return {'id': str(uuid4()), 'content': text, 'status': 'active',
            'vector': [0.2] * width, 'epistemicStatus': 'observed', **values}


def store_at(root, identity=PRIMARY, width=2):
    return SharedPoolStore(root, SharedPrincipal('sync-workspace', 'cli', '', 'owner'),
                           embedding_fingerprint=identity, embedding_dimensions=width)


def test_only_exact_verified_space_and_width_enter_shared_ann(tmp_path):
    store = store_at(tmp_path)
    store.copy(card('Atlas primary exact vector'), source_agent='alpha', embedding_fingerprint=PRIMARY)
    store.copy(card('Atlas different model same width'), source_agent='alpha', embedding_fingerprint=SAME_WIDTH)
    store.copy(card('Atlas different model different width', 3), source_agent='alpha', embedding_fingerprint=DIFFERENT_WIDTH)
    store.copy(card('Atlas legacy with unknown space'), source_agent='alpha')

    ann = store.recall_rows([0.2, 0.2], 10)
    assert [row['content'] for row in ann] == ['Atlas primary exact vector']
    assert ann[0]['embeddingFingerprint'] == PRIMARY
    lexical = store.recall_lexical_rows('Find Atlas', 10)
    assert {row['content'] for row in lexical} == {
        'Atlas different model same width', 'Atlas different model different width', 'Atlas legacy with unknown space',
    }
    assert all(row['_sharedRetrieval'] == 'keyword' and '_distance' not in row and 'vector' not in row for row in lexical)
    wrong = store_at(tmp_path, PRIMARY, 3)
    assert wrong.recall_rows([0.2, 0.2, 0.2], 10) == []
    assert {row['content'] for row in wrong.recall_lexical_rows('Atlas', 10)} == {
        'Atlas primary exact vector', 'Atlas different model same width',
        'Atlas different model different width', 'Atlas legacy with unknown space',
    }


def test_reshare_commits_one_route_and_keeps_previous_on_receipt_failure(tmp_path, monkeypatch):
    store = store_at(tmp_path)
    original = card('Atlas old current copy')
    first = store.copy(original, source_agent='alpha', embedding_fingerprint=PRIMARY)
    updated = {**original, 'content': 'Atlas new current copy', 'vector': [0.2, 0.2, 0.2]}
    with monkeypatch.context() as context:
        def fail_store(*_args):
            raise OSError('test receipt write failed')
        context.setattr(store, '_publish_route', fail_store)
        with pytest.raises(OSError):
            store.copy(updated, source_agent='alpha', embedding_fingerprint=DIFFERENT_WIDTH)
    assert [row['content'] for row in store.recall_rows([0.2, 0.2], 10)] == ['Atlas old current copy']
    assert store.recall_lexical_rows('Atlas', 10) == []

    second = store.copy(updated, source_agent='alpha', embedding_fingerprint=DIFFERENT_WIDTH)
    assert second['id'] == first['id']
    assert store.recall_rows([0.2, 0.2], 10) == []
    assert [row['content'] for row in store.recall_lexical_rows('Atlas', 10)] == ['Atlas new current copy']
    target = store_at(tmp_path, DIFFERENT_WIDTH, 3)
    assert [row['content'] for row in target.recall_rows([0.2, 0.2, 0.2], 10)] == ['Atlas new current copy']
    assert target.recall_lexical_rows('Atlas', 10) == []


def test_legacy_keyword_projection_preserves_scope_lifecycle_and_sensitivity(tmp_path):
    store = store_at(tmp_path)
    path = store._path(True)
    path.mkdir(parents=True)
    base = {'sharedScope': 'user', 'principalHash': store.principal.user_key,
            'expiresAt': 0, 'validFrom': 0, 'validUntil': 0, 'sensitivity': ''}
    lancedb.connect(str(path)).create_table('memories', [
        {**base, **card('Atlas private foreign'), 'principalHash': 'foreign'},
        {**base, **card('Atlas invalidated', epistemicStatus=' INVALIDATED ')},
        {**base, **card('Atlas expired', expiresAt=5)},
        {**base, **card('Atlas future', validFrom=200)},
        {**base, **card('Atlas restricted', sensitivity='confidential')},
        {**base, **card('Atlas ordinary allowed', validFrom=20, validUntil=150)},
    ])
    assert store.recall_rows([0.1, 0.2], 10, valid_at=100, now_ms=100) == []
    found = store.recall_lexical_rows('Atlas', 1, valid_at=100, now_ms=100)
    assert [row['content'] for row in found] == ['Atlas ordinary allowed']
    other = SharedPoolStore(tmp_path, SharedPrincipal('sync-workspace', 'cli', '', 'different'))
    assert other.recall_lexical_rows('Atlas', 10, valid_at=100, now_ms=100) == []
