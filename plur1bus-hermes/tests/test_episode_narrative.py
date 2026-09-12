import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

from plur1bus_hermes.domain import Plur1busDomain
from plur1bus_hermes.episode_narrative import group_turns, enrich, enrichment_key
from plur1bus_hermes.runtime import Plur1busRuntime


class EpisodeNarrativeTests(unittest.TestCase):
    def turns(self, count=6):
        return [{"id": str(index), "sessionId": "s", "role": "user",
                 "content": f"fact {index}", "createdAt": (
                     datetime(2026, 9, 1, tzinfo=timezone.utc) + timedelta(minutes=index)
                 ).isoformat()} for index in range(count)]

    @staticmethod
    def completion(_purpose, _system, payload):
        return {"title": "Discussion", "summary": "Tentative narrative.",
                "narrativeArc": "exploration", "turningPoint": "",
                "evidenceTurnIds": [row["id"] for row in json.loads(payload)]}

    def test_group_gap_size_and_session_boundaries(self):
        self.assertEqual([len(group) for group in group_turns(self.turns(51))], [50, 1])
        turns = self.turns()
        turns[-1]["sessionId"] = "separate"
        self.assertEqual([len(group) for group in group_turns(turns)], [5, 1])
        turns = self.turns()
        turns[-1]["createdAt"] = "2026-09-02T00:00:00+00:00"
        self.assertEqual([len(group) for group in group_turns(turns)], [5, 1])

    def test_short_unknown_evidence_and_changed_content(self):
        self.assertIsNone(enrich(self.turns(4), lambda *_: self.fail("short group used LLM")))
        def forged(*args):
            return {**self.completion(*args), "evidenceTurnIds": ["foreign"]}
        self.assertIsNone(enrich(self.turns(), forged))
        turns = self.turns()
        before = enrichment_key(turns)
        turns[0]["content"] = "changed"
        self.assertNotEqual(before, enrichment_key(turns))

    def test_enrichment_key_binds_every_source_identity_and_revision_field(self):
        original = self.turns()
        before = enrichment_key(original)
        for field, value in {
            "id": "replacement-id", "agentId": "other-agent", "scopeKey": "other-scope",
            "sessionId": "other-session", "role": "assistant", "content": "revised claim",
            "createdAt": "2026-09-02T00:00:00+00:00",
        }.items():
            with self.subTest(field=field):
                revised = [dict(row) for row in original]
                revised[0][field] = value
                self.assertNotEqual(enrichment_key(revised), before)
        original[0]["content"] = "a" * 200 + "original suffix"
        revised = [dict(row) for row in original]
        revised[0]["content"] = "a" * 200 + "changed suffix"
        self.assertNotEqual(enrichment_key(original), enrichment_key(revised))

    def test_native_journal_is_scoped_idempotent_and_preserves_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Plur1busRuntime(Path(directory), {"episodes": {"llmNarrative": True}}, "main")
            try:
                domain = runtime._domain
                domain._llm_backend = SimpleNamespace(available=lambda: True, complete_json=self.completion)
                for index in range(3):
                    domain.on_turn(f"user fact {index}", f"assistant claim {index}", "session")
                domain._append_jsonl(domain.neo_dir / "turn-journal.jsonl", {
                    **self.turns()[0], "agentId": "other", "scopeKey": "foreign", "content": "secret",
                })
                first = domain.run_episode_narratives()
                self.assertTrue(first["executed"])
                self.assertFalse(domain.run_episode_narratives()["executed"])
                records = domain._read_jsonl(domain.neo_dir / "episode-narratives.jsonl")
                self.assertEqual(len(records), 1)
                self.assertEqual(len(records[0]["evidenceTurnIds"]), 6)
                self.assertFalse(records[0]["visibility"]["recallable"])
                self.assertEqual(len(domain._read_jsonl(domain.neo_dir / "episodes.jsonl")), 3)
                domain.on_turn("next user", "next assistant", "session")
                def unavailable(*_args):
                    raise TimeoutError("offline")
                domain._llm_backend.complete_json = unavailable
                self.assertFalse(domain.run_episode_narratives()["executed"])
                self.assertEqual(len(domain._read_jsonl(domain.neo_dir / "episode-narratives.jsonl")), 1)
            finally:
                runtime.shutdown()


class EpisodeEarlyIdempotenceTests(unittest.TestCase):
    """Durable narrative success skips enrichment, not new or revised evidence."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.config = {"episodes": {"llmNarrative": True}}
        self.domain = Plur1busDomain(Path(self.temporary.name), "main", self.config)
        self.complete = Mock(side_effect=EpisodeNarrativeTests.completion)
        self.domain._llm_backend = SimpleNamespace(available=lambda: True, complete_json=self.complete)

    def seed(self, *, acl_bindings=None, rows=None, root=False):
        selector = self.domain._scope_selector(acl_bindings=acl_bindings)
        directory = self.domain.neo_dir if root else self.domain._scope_neo_dir(selector)
        source = rows if rows is not None else EpisodeNarrativeTests().turns()
        records = [{**row, "agentId": "main", "scopeKey": selector.scope_key,
                    "aclBindings": selector.acl_bindings} for row in source]
        for row in records:
            self.domain._append_jsonl(directory / "turn-journal.jsonl", row)
        return records, directory

    def test_exact_replay_and_process_restart_skip_before_backend(self):
        self.seed()
        first = self.domain.run_episode_narratives()
        self.assertTrue(first["executed"])
        self.assertEqual(first["skippedEpisodedSpans"], 0)
        path = self.domain.neo_dir / "episode-narratives.jsonl"
        original = path.read_bytes()
        for domain in (self.domain, Plur1busDomain(Path(self.temporary.name), "main", self.config)):
            domain._llm_backend = SimpleNamespace(available=lambda: True, complete_json=self.complete)
            result = domain.run_episode_narratives()
            self.assertFalse(result["executed"])
            self.assertEqual(result["created"], [])
            self.assertEqual(result["skippedEpisodedSpans"], 1)
            self.assertEqual(path.read_bytes(), original)
        self.complete.assert_called_once()

    def test_partial_overlap_requires_new_narrative_without_rewriting_previous(self):
        rows, directory = self.seed()
        self.domain.run_episode_narratives()
        path = directory / "episode-narratives.jsonl"
        previous = self.domain._read_jsonl(path)[0]
        extended = {**rows[-1], "id": "next-turn", "role": "assistant",
                    "content": "new assistant claim", "createdAt": "2026-09-01T00:06:00+00:00"}
        self.domain._append_jsonl(directory / "turn-journal.jsonl", extended)
        result = self.domain.run_episode_narratives()
        self.assertTrue(result["executed"])
        self.assertEqual(result["skippedEpisodedSpans"], 0)
        records = self.domain._read_jsonl(path)
        self.assertEqual(len(records), 2)
        self.assertEqual(records[0], previous)
        self.assertNotEqual(records[0]["key"], records[1]["key"])
        self.assertEqual(records[1]["sourceRoles"]["next-turn"], "assistant")
        self.assertEqual(self.complete.call_count, 2)

    def test_revised_content_and_role_with_same_ids_are_not_covered(self):
        rows, directory = self.seed()
        self.domain.run_episode_narratives()
        for field, value in (("content", "revised claim"), ("role", "assistant")):
            with self.subTest(field=field):
                rows[0][field] = value
                (directory / "turn-journal.jsonl").write_text(
                    "".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
                self.assertTrue(self.domain.run_episode_narratives()["executed"])
        self.assertEqual(self.complete.call_count, 3)
        self.assertFalse(self.domain.run_episode_narratives()["executed"])

    def test_foreign_partition_rows_neither_reach_model_nor_suppress_success(self):
        for bindings in (None, {"scopeType": "workspace", "workspaceIdentity": "workspace-a"}):
            with self.subTest(bindings=bindings):
                rows, directory = self.seed(acl_bindings=bindings)
                for row in rows:
                    self.domain._append_jsonl(directory / "turn-journal.jsonl", {
                        **row, "id": "foreign-" + row["id"], "agentId": "other-agent",
                        "scopeKey": "foreign-scope", "content": "FOREIGN SECRET",
                    })
                self.domain._append_jsonl(directory / "episode-narratives.jsonl", {
                    "key": enrichment_key(rows), "agentId": "other-agent", "scopeKey": "foreign-scope",
                })
                result = self.domain.run_episode_narratives(acl_bindings=bindings)
                self.assertTrue(result["executed"])
                self.assertEqual(result["skippedEpisodedSpans"], 0)
                payload = json.loads(self.complete.call_args.args[2])
                self.assertEqual({row["id"] for row in payload}, {row["id"] for row in rows})
                self.assertNotIn("FOREIGN SECRET", str(payload))
                self.assertEqual(self.domain.run_episode_narratives(
                    acl_bindings=bindings)["skippedEpisodedSpans"], 1)
        self.assertEqual(self.complete.call_count, 2)

    def test_legacy_root_scoped_success_is_reused_after_scope_partitioning(self):
        binding = {"scopeType": "workspace", "workspaceIdentity": "legacy-workspace"}
        rows, _ = self.seed(acl_bindings=binding, root=True)
        successful = {**enrich(rows, EpisodeNarrativeTests.completion),
                      "agentId": "main", "scopeKey": rows[0]["scopeKey"]}
        self.domain._append_jsonl(self.domain.neo_dir / "episode-narratives.jsonl", successful)
        result = self.domain.run_episode_narratives(acl_bindings=binding)
        self.assertFalse(result["executed"])
        self.assertEqual(result["skippedEpisodedSpans"], 1)
        self.complete.assert_not_called()

    def test_failure_and_invalid_evidence_are_retryable_not_completed(self):
        self.seed()
        successful = EpisodeNarrativeTests.completion("", "", json.dumps(EpisodeNarrativeTests().turns()))
        self.complete.side_effect = [TimeoutError("offline"), {**successful, "evidenceTurnIds": ["foreign"]}, successful]
        for _ in range(2):
            result = self.domain.run_episode_narratives()
            self.assertFalse(result["executed"])
            self.assertEqual(result["skippedEpisodedSpans"], 0)
            self.assertEqual(self.domain._read_jsonl(self.domain.neo_dir / "episode-narratives.jsonl"), [])
        self.assertTrue(self.domain.run_episode_narratives()["executed"])
        self.assertEqual(self.domain.run_episode_narratives()["skippedEpisodedSpans"], 1)
        self.assertEqual(self.complete.call_count, 3)

    def test_malformed_completion_key_cannot_abort_new_enrichment(self):
        rows, directory = self.seed()
        self.domain._append_jsonl(directory / "episode-narratives.jsonl", {
            "key": ["not-a-digest"], "agentId": "main", "scopeKey": rows[0]["scopeKey"],
        })
        self.assertTrue(self.domain.run_episode_narratives()["executed"])
        self.complete.assert_called_once()
