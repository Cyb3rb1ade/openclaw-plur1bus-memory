"""Hermes execution regressions for the 7.12.3 through 7.12.7 upstream delta."""
from unittest.mock import patch
import threading

import pytest

from plur1bus_hermes.provider import Plur1busMemoryProvider
from plur1bus_hermes.query_refinement import refine_query
from plur1bus_hermes.runtime import EmbeddingBackend


@pytest.mark.parametrize('text', ['Übergröße München', 'U\u0308bergro\u0308ße Mu\u0308nchen'])
def test_refinement_preserves_canonical_umlauts(text):
    assert refine_query(text) == 'übergröße münchen'


def test_prompt_does_not_infer_dates_from_transcript_order():
    prompt = Plur1busMemoryProvider().system_prompt_block()
    assert 'transcript' in prompt and 'timestamps' in prompt
    assert 'position' in prompt and 'guess' in prompt


def test_provider_cancels_waiting_recall_without_starting_it():
    provider = Plur1busMemoryProvider({'autoRecall': True, 'recall': {'currentTurnWaitMs': 10}})
    started = [threading.Event(), threading.Event()]
    finish = threading.Event()
    called = []
    def recall(query, session_id, runtime):
        called.append(query)
        if query in ('first', 'second'):
            started[0 if query == 'first' else 1].set()
            finish.wait(3)
        return 'result'
    provider._run_recall = recall
    provider._current_recall_wait_seconds = lambda: 0.01
    try:
        provider.queue_prefetch('first')
        provider.queue_prefetch('second')
        assert all(event.wait(1) for event in started)
        assert provider.prefetch('expired') == ''
        assert 'expired' not in called
        assert provider._prefetch_executor.metrics['pending'] == 2
    finally:
        finish.set()
        provider._prefetch_executor.shutdown(wait=True)
        provider.shutdown()
    assert 'expired' not in called


def test_provider_rejects_overflow_without_unbounded_background_work():
    provider = Plur1busMemoryProvider()
    finish = threading.Event()
    provider._run_recall = lambda *args: finish.wait(3) and ''
    try:
        for index in range(25):
            provider.queue_prefetch(str(index))
        assert provider._prefetch_executor.metrics['pending'] == 10
        assert provider._prefetch_executor.metrics['rejected'] == 15
    finally:
        finish.set()
        provider._prefetch_executor.shutdown(wait=True)
        provider.shutdown()


@pytest.mark.parametrize('provider', ['openai-compatible', 'omlx'])
@pytest.mark.parametrize('setting,seconds', [({}, 15), ({'requestTimeoutMs': 2500}, 2.5),
    ({'requestTimeoutMs': 1}, 15), ({'requestTimeoutMs': 'nan'}, 15),
    ({'requestTimeoutMs': float('inf')}, 15), ({'timeoutSeconds': 3}, 3)])
def test_remote_embedding_honors_bounded_timeout_without_retries(tmp_path, provider, setting, seconds):
    backend = EmbeddingBackend({'provider': provider, 'model': 'embed', 'dimensions': 2,
        'apiKey': 'fixture-key', **setting}, tmp_path)
    try:
        with patch('urllib.request.urlopen', side_effect=TimeoutError) as request:
            with pytest.raises(RuntimeError):
                backend.embed('fixture')
        assert request.call_count == 1
        assert request.call_args.kwargs['timeout'] == seconds
    finally:
        backend.close()
