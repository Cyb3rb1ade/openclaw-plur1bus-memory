"""Native contracts from upstream 7.12.57–7.12.60; no productive state."""
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from plur1bus_hermes.llm_backend import InternalLlmBackend
from plur1bus_hermes.proactive import ProactiveEngine
from plur1bus_hermes.cognition import extract_open_threads


class Upstream760NativeTests(unittest.TestCase):
    def test_explicit_corrections_are_captured_without_inventing_open_threads(self):
        self.assertEqual(extract_open_threads('Korrektur: Version zwei verwenden.'), ['Korrektur: Version zwei verwenden.'])
        self.assertEqual(extract_open_threads('Correction: use version two.'), ['Correction: use version two.'])
        self.assertEqual(extract_open_threads('Version two is installed.'), [])

    def test_default_model_reaches_real_request_builder_without_changing_transport(self):
        requests = []
        class Response:
            def __enter__(self):
                return self
            def __exit__(self, *_args):
                return False
            def read(self):
                return json.dumps({'choices': [{'message': {'content': '{"query":"refined"}'}}]}).encode()
        def opener(request, **kwargs):
            requests.append(request)
            return Response()
        backend = InternalLlmBackend({'llm': {'baseUrl': 'https://example.invalid/v1', 'provider': 'custom',
                                               'requestExtra': {'temperature': 0}},
                                      'llmRouter': {'defaultModel': 'small'}}, 'main', opener=opener)
        self.assertEqual(backend.complete_json('query-refinement', 'system', 'question'), {'query': 'refined'})
        self.assertEqual(requests[0].full_url, 'https://example.invalid/v1/chat/completions')
        self.assertEqual(json.loads(requests[0].data)['model'], 'small')
        self.assertEqual(json.loads(requests[0].data)['temperature'], 0)

    def test_afterthought_boundaries_closed_state_and_ambiguous_legacy(self):
        now = datetime(2026, 9, 17, 12, tzinfo=timezone.utc)
        for age, expected in [(29, True), (30, False), (180, False), (181, True)]:
            with self.subTest(age=age), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                engine = ProactiveEngine(root / 'state', root / 'neo', root / 'workspace')
                thread = {'id': 'a', 'text': 'What next?', 'status': 'open',
                          'createdAt': (now - timedelta(minutes=age)).isoformat()}
                with patch.object(engine, '_jsonl', side_effect=lambda path: [thread] if path.name == 'open-threads.jsonl' else []):
                    self.assertEqual(engine.afterthought(now=now)['skipped'], expected)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            engine = ProactiveEngine(root / 'state', root / 'neo', root / 'workspace')
            recent = (now - timedelta(minutes=60)).isoformat()
            values = {'episodes.jsonl': [{'sessionId': 's', 'endTime': recent}] * 2,
                      'open-threads.jsonl': [
                          {'id': 'a', 'text': 'Closed?', 'status': 'open', 'createdAt': recent},
                          {'id': 'a', 'text': 'Closed?', 'status': 'closed', 'createdAt': recent},
                          {'id': 'b', 'text': 'Ambiguous?', 'status': 'open', 'sessionId': 's'}]}
            with patch.object(engine, '_jsonl', side_effect=lambda path: values[path.name]):
                self.assertTrue(engine.afterthought(now=now)['skipped'])

    def test_background_default_does_not_override_explicit_native_model(self):
        backend = InternalLlmBackend({'llmRouter': {'defaultModel': ' small '}}, 'main')
        self.assertTrue(backend.available())
        self.assertEqual(backend.config['model'], 'small')
        explicit = InternalLlmBackend({'llm': {'model': 'owned', 'baseUrl': 'https://example.invalid/v1'},
                                       'llmRouter': {'defaultModel': 'small'}}, 'main')
        self.assertEqual(explicit.config['model'], 'owned')
        self.assertFalse(InternalLlmBackend({'llmRouter': {'defaultModel': '  '}}, 'main').available())

    def test_afterthought_uses_thread_time_not_latest_heartbeat(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            engine = ProactiveEngine(root / 'state', root / 'neo', root / 'workspace')
            engine.neo_dir.mkdir()
            now = datetime(2026, 9, 17, 12, tzinfo=timezone.utc)
            episodes = [{'endTime': (now - timedelta(minutes=1)).isoformat()}]
            threads = [
                {'id': 'older', 'text': 'An older question?', 'status': 'open',
                 'createdAt': (now - timedelta(minutes=170)).isoformat()},
                {'id': 'corrected', 'text': 'Correction: use version two.', 'status': 'corrected',
                 'createdAt': (now - timedelta(minutes=150)).isoformat()},
                {'id': 'closed', 'text': 'Done.', 'status': 'closed',
                 'createdAt': (now - timedelta(minutes=40)).isoformat()},
            ]
            (engine.neo_dir / 'episodes.jsonl').write_text('\n'.join(map(json.dumps, episodes)))
            (engine.neo_dir / 'open-threads.jsonl').write_text('\n'.join(map(json.dumps, threads)))
            result = engine.afterthought(now=now)
            self.assertFalse(result['skipped'])
            self.assertEqual(result['message']['topicId'], 'afterthought:corrected')
            self.assertTrue(engine.afterthought(now=now)['skipped'])

    def test_invalid_or_stale_thread_time_cannot_borrow_a_recent_episode(self):
        now = datetime(2026, 9, 17, 12, tzinfo=timezone.utc)
        for timestamp in ['invalid', (now - timedelta(minutes=181)).isoformat()]:
            with self.subTest(timestamp=timestamp), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                engine = ProactiveEngine(root / 'state', root / 'neo', root / 'workspace')
                values = {'episodes.jsonl': [{'endTime': (now - timedelta(minutes=45)).isoformat()}],
                          'open-threads.jsonl': [{'id': 'stale', 'text': 'Old?', 'status': 'open', 'createdAt': timestamp}]}
                with patch.object(engine, '_jsonl', side_effect=lambda path: values[path.name]):
                    self.assertTrue(engine.afterthought(now=now)['skipped'])
