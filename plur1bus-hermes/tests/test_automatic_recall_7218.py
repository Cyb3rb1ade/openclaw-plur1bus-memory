"""Hermes-native automatic recall across a blocked embedding and old rows."""

from __future__ import annotations

import json
import threading
import time
import unittest
import uuid
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import MagicMock, patch

from plur1bus_hermes.runtime import Plur1busRuntime, RerankerBackend
from plur1bus_hermes.runtime_lease import exclusive_generation_lease


class AutomaticRecallTests(unittest.TestCase):
    def _runtime(self, root: str, **config) -> Plur1busRuntime:
        runtime = Plur1busRuntime(Path(root), {"embedding": {"dimensions": 2}, **config}, "default")
        runtime._embedding.embed = lambda _text, **_kwargs: [0.1, 0.2]
        runtime._domain.on_memory = lambda *_args, **_kwargs: None
        runtime._domain.recall_overlay = lambda *_args, **_kwargs: ""
        runtime._domain.contradiction_context = lambda *_args, **_kwargs: ""
        runtime._domain.cognitive_prompt_blocks = lambda **_kwargs: []
        self.addCleanup(runtime.shutdown)
        return runtime

    def test_auto_recall_preserves_head_and_tail_and_never_calls_llm_refiner(self):
        with TemporaryDirectory() as root:
            runtime = self._runtime(root, recall={"queryRefinement": {"useLlm": True}})
            runtime._remember("A project fact distinct from the input", "older-session", "user")
            observed = []

            def embed(query, **_kwargs):
                observed.append(query)
                return [0.6, 0.8]  # Deliberately different from the stored vector.

            runtime._embedding.embed = embed
            runtime._internal_llm.complete_json = MagicMock(side_effect=AssertionError("automatic recall invoked the model"))
            query = "opening detail " + "old text " * 6_000 + " final question"
            runtime.recall(query, automatic=True)
            self.assertTrue(observed)
            self.assertTrue(all(len(text) <= 6000 for text in observed))
            self.assertTrue(observed[0].startswith("opening detail"))
            self.assertTrue(observed[0].endswith("final question"))
            runtime._internal_llm.complete_json.assert_not_called()

    def test_exact_echo_is_removed_only_in_automatic_mode_even_if_booster_returns_it(self):
        with TemporaryDirectory() as root:
            runtime = self._runtime(root)
            query = "Bitte überprüfe den neuen Hermes Installer für Apple Silicon"
            runtime._remember(query, "older-session", "user")
            runtime._remember("The previous installer bundled the profile picker", "older-session", "assistant")
            table, _ = runtime._table(create=False)
            echo = next(row for row in table.search().limit(2).to_list() if row["content"] == query)
            runtime._domain.boost_recall = lambda rows, *_args, **_kwargs: rows + [echo]

            manual = runtime.recall(query)
            automatic = runtime.recall(query, automatic=True)
            self.assertIn(query, manual)
            self.assertNotIn(query, automatic)
            self.assertIn("previous installer bundled", automatic)

    def test_slow_embedding_uses_scoped_keyword_fallback_and_keeps_lease(self):
        with TemporaryDirectory() as root:
            runtime = self._runtime(root)
            eligible = "Hermes Polaris project migration uses staged snapshots"
            runtime._remember(eligible, "past", "user")
            table, _ = runtime._table(create=False)
            row = table.search().limit(1).to_list()[0]
            table.add([
                {**row, "id": str(uuid.uuid4()), "scopeKey": "foreign-scope", "content": "Polaris confidential other profile"},
                {**row, "id": str(uuid.uuid4()), "expiresAt": 1, "content": "Polaris expired content"},
            ])
            entered, finish = threading.Event(), threading.Event()

            def block(*_args, **_kwargs):
                entered.set()
                if not finish.wait(5):
                    raise TimeoutError
                return [0.1, 0.2]

            runtime._embedding.embed = block
            try:
                started = time.monotonic()
                recalled = runtime.recall("Find the Polaris project migration evidence", automatic=True, timeout_seconds=0.8)
                self.assertTrue(entered.is_set())
                self.assertLess(time.monotonic() - started, 1.5)
                self.assertIn(eligible, recalled)
                self.assertIn('retrieval="keyword-recent-fallback"', recalled)
                self.assertNotIn("confidential other profile", recalled)
                self.assertNotIn("expired content", recalled)
                runtime.shutdown(timeout_seconds=0)
                with self.assertRaisesRegex(RuntimeError, "runtime lease"):
                    with exclusive_generation_lease(Path(root)):
                        pass
            finally:
                finish.set()
                runtime.shutdown()

    def test_temporal_hard_filter_requires_explicit_relative_conversation_intent(self):
        from plur1bus_hermes.query_refinement import conversation_recall_range

        now = datetime(2026, 11, 24, 12, tzinfo=timezone.utc)
        for query in (
            "Was haben wir gestern besprochen?",
            "Die Daten hatte ich dir doch gestern gegeben",
            "What did we discuss yesterday?",
            "What did you say yesterday?",
            "The user mentioned a dentist appointment 2 hours ago",
            "Unsere Chats von gestern",
        ):
            with self.subTest(query=query):
                self.assertIsNotNone(conversation_recall_range(query, now=now))
        for query in (
            "Was war gestern?",
            "I talked to Max today",
            "Wir haben heute mit Max gesprochen",
            "What did I tell you yesterday about the next trip?",
            "Was hast du mir gestern über den Termin heute gesagt?",
            "Did you hear what happened in Berlin today?",
            "Hast du gesehen was Eva gestern gesagt hat?",
            "Wir haben im Mai 2026 über das Dach gesprochen",
            "Was habe ich dir seit gestern gesagt?",
        ):
            with self.subTest(query=query):
                self.assertIsNone(conversation_recall_range(query, now=now))
        match = conversation_recall_range("Heute regnet es. Was hast du mir gestern über das Dach gesagt?", now=now)
        self.assertEqual(match["start"], "2026-11-22T22:00:00+00:00")
        self.assertEqual(match["end"], "2026-11-24T02:00:00+00:00")

    def test_recall_expands_a_ranked_list_fragment_to_its_scoped_whole(self):
        with TemporaryDirectory() as root:
            runtime = self._runtime(root, recall={"candidateTopK": 1, "queryRefinement": False})
            origin = str(uuid.uuid4())
            whole = "Worauf achten:\n1. Online Reviews lesen.\n2. Referenzen vergleichen."
            part = "Worauf achten: Online Reviews lesen."
            runtime._embedding.embed = lambda text, **_kwargs: [0.3, 0.4] if text == whole else [0.1, 0.2]
            runtime._remember(whole, "older-session", "user", source_turn_id=origin)
            runtime._remember(part, "older-session", "user", source_turn_id=origin, chunk_group_id=str(uuid.uuid4()))
            self.assertIn("Referenzen vergleichen", runtime.recall("Reviews"))

    def test_unrelated_row_cannot_substitute_for_a_fragment_in_another_scope(self):
        from plur1bus_hermes.recall_origins import prefer_whole_rows

        part = {
            "id": "child", "_namespace": "first", "scopeKey": "owner", "sourceRole": "user",
            "sourceTurnId": "turn", "chunkGroupId": "parts", "content": "Online Reviews lesen.",
        }
        wholes = [
            {**part, "id": "other-content", "chunkGroupId": "", "content": "Andere Nachricht"},
            {**part, "id": "other-namespace", "_namespace": "elsewhere", "chunkGroupId": ""},
            {**part, "id": "other-scope", "scopeKey": "foreign", "chunkGroupId": ""},
            {**part, "id": "other-role", "sourceRole": "assistant", "chunkGroupId": ""},
        ]
        self.assertEqual(prefer_whole_rows([part], wholes), [part])

    def test_rendering_explains_relative_time_with_a_real_created_at(self):
        with TemporaryDirectory() as root:
            runtime = self._runtime(root)
            runtime._remember("We reopened the project yesterday", "older", "user")
            result = runtime.recall("project")
            self.assertIn("RELATIVE TIME:", result)
            self.assertIn("created-at=", result)
            self.assertLess(result.index("RELATIVE TIME:"), result.index("We reopened"))

    def test_cohere_default_and_document_bound_keep_original_content(self):
        with TemporaryDirectory() as root:
            reranker = RerankerBackend({}, Path(root))
            self.addCleanup(reranker.close)
            rows = [{"id": "row", "content": "x" * 1600}]
            response = MagicMock()
            response.__enter__.return_value.read.return_value = (
                b'{"results":[{"index":0,"relevance_score":0.7}]}'
            )
            with patch("plur1bus_hermes.runtime.profile_secret", return_value="test-key"), patch(
                "plur1bus_hermes.runtime.urllib.request.urlopen", return_value=response
            ) as urlopen:
                ranked = reranker._rerank_cohere({}, "example", rows)
            payload = json.loads(urlopen.call_args.args[0].data)
            self.assertEqual(payload["model"], "rerank-v5.0-fast")
            self.assertEqual(len(payload["documents"][0]), 1400)
            self.assertNotIn("return_documents", payload)
            self.assertEqual(ranked[0]["content"], rows[0]["content"])
