"""Native .62–.69 contracts using real LanceDB and deterministic fake judgments."""
import json
from pathlib import Path
import tempfile
import unittest
import uuid

import lancedb

from plur1bus_hermes.domain import Plur1busDomain
from plur1bus_hermes.dynamics import DAY_MS, reinforce_metadata, transform_metadata
from plur1bus_hermes.encoding import encoding_prompt, half_life_from_encoding, refine_patch
from plur1bus_hermes.encoding_job import run_encoding, reinforce_recall
from plur1bus_hermes.llm_backend import InternalLlmBackend, InvalidLlmResponse
from plur1bus_hermes.namespaces import binding_from_scope


class Encoding769Tests(unittest.TestCase):
    def test_encoding_budget_is_independent_of_disabled_emotion_tier(self):
        seen = []
        class Response:
            def __enter__(self):
                return self
            def __exit__(self, *args):
                return False
            def read(self):
                return json.dumps({"choices": [{"message": {"content": '{"importance":0.8}'}}]}).encode()
        def opener(request, **kwargs):
            seen.append(json.loads(request.data))
            return Response()
        backend = InternalLlmBackend({"llm": {"model": "test", "baseUrl": "https://example.invalid/v1"},
            "emotion": {"t3": {"enabled": False, "encodingMaxTokens": 0}}}, "main", opener=opener)
        backend.complete_json("memory-encoding", "s", "u")
        backend.complete_json("other", "s", "u")
        self.assertEqual([payload["max_tokens"] for payload in seen], [1500, 300])

    def test_strict_judgment_and_sparse_emotions(self):
        for invalid in (None, True, "0.8", float("nan"), 10**400, [], {}):
            self.assertIsNone(refine_patch({}, {"importance": invalid}, 42))
        patch = refine_patch({}, {"importance": 1, "intensity": 0.8, "dominant": "disgust"}, 42)
        self.assertEqual(patch["importance"], 0.94)
        self.assertEqual(patch["emotionalValence"]["disgust"], 0.8)
        self.assertEqual(patch["emotionalValence"]["trust"], 0)
        self.assertEqual(patch["halfLifeDays"], 600)
        self.assertNotIn("lastDynamicsAt", patch)

    def test_unicode_and_half_life_bands(self):
        encoding_prompt("a" * 1999 + "🎙").encode("utf-8")
        encoding_prompt("a" * 1999 + "\ud83c").encode("utf-8")
        self.assertEqual([half_life_from_encoding(v) for v in (0.1, 0.5, 0.8, 0.95)], [30, 180, 600, 36500])

    def test_agent_decision_and_provenance_survive_refinement(self):
        original = {"importance": 0.97, "halfLifeDays": 36500, "coreMemoryReason": "manual_importance_marker",
                    "updateSource": "rollback", "memoryStrength": 1}
        patch = refine_patch(original, {"importance": 0.8, "intensity": 1}, 42, flashbulb=True)
        for key in original:
            self.assertNotIn(key, patch)
        self.assertEqual(patch["importanceStatus"], "final")

    def test_flashbulb_opt_in_and_never_lower_strength(self):
        judgment = {"importance": 0.8, "intensity": 0.8}
        self.assertEqual(refine_patch({}, judgment, 42)["halfLifeDays"], 600)
        patch = refine_patch({"memoryStrength": 1}, judgment, 42, flashbulb=True)
        self.assertEqual(patch["halfLifeDays"], 3650)
        self.assertEqual(patch["memoryStrength"], 1)

    def test_spaced_retrieval_not_burst_and_zero_stays_zero(self):
        row = {"halfLifeDays": 30, "memoryStrength": 0.5, "lastDynamicsAt": DAY_MS}
        first = reinforce_metadata(row, 2 * DAY_MS)
        self.assertAlmostEqual(first["halfLifeDays"], 34.5)
        self.assertEqual(reinforce_metadata(first, 2 * DAY_MS + 1)["halfLifeDays"], 34.5)
        for days in (600, 3650, 36500):
            self.assertEqual(reinforce_metadata({**row, "halfLifeDays": days}, 2 * DAY_MS)["halfLifeDays"], days)
        self.assertEqual(reinforce_metadata({**row, "memoryStrength": 0}, 2 * DAY_MS)["memoryStrength"], 0)
        core = transform_metadata({**row, "memoryClass": "core"}, (), now_ms=1000 * DAY_MS)
        self.assertEqual(core["metadata"]["memoryStrength"], 1)

    def test_capture_neutral_and_agent_band(self):
        with tempfile.TemporaryDirectory() as root:
            domain = Plur1busDomain(Path(root), "main")
            for text in ("Knie", "Zimmer", "nie vergessen wichtig", "remember this", "ordinary"):
                metadata = domain._metadata_for({"content": text, "sourceRole": "user"})
                self.assertEqual((metadata["importance"], metadata["importanceStatus"]), (0.5, "pending"))
            explicit = domain._metadata_for({"content": "important"}, importance=0.95)
            self.assertTrue(explicit["neverForget"])
            self.assertEqual(explicit["importanceStatus"], "final")

    def test_scoped_hourly_real_database_and_legacy_untouched(self):
        with tempfile.TemporaryDirectory() as root:
            domain = Plur1busDomain(Path(root), "main")
            binding = binding_from_scope("main")
            database = lancedb.connect(str(Path(root) / "lancedb/main"))
            rows, cards = [], []
            for state in ("pending", "pending_backfill", "final", "unknown"):
                memory_id = str(uuid.uuid4())
                metadata = {"text": state, "importance": 0.5, "importanceStatus": state,
                            "scopeKey": binding.scope_key, "status": "active", "memoryStrength": 1}
                rows.append({"id": memory_id, "agentId": "main", "scopeKey": binding.scope_key,
                             "metadataJson": json.dumps(metadata)})
                cards.append({"id": memory_id, "agentId": "main", "scopeKey": binding.scope_key,
                              "status": "active", "content": state})
            table = database.create_table("metadata", data=rows)
            memories = database.create_table("memories", data=cards)
            class Backend:
                def available(self):
                    return True
                def complete_json(self, *args):
                    return {"importance": 0.8, "dominant": "neutral"}
            domain.set_llm_backend(Backend())
            result = run_encoding(domain, memories)
            self.assertEqual(result["refined"], 1)
            table = database.open_table("metadata")
            values = {json.loads(row["metadataJson"])["text"]: json.loads(row["metadataJson"])
                      for row in table.to_arrow().to_pylist()}
            self.assertEqual(values["pending"]["importance"], 0.8)
            for state in ("pending_backfill", "final", "unknown"):
                self.assertEqual(values[state]["importance"], 0.5)
            self.assertEqual(run_encoding(domain, memories)["refined"], 0)
            # Delayed usage never strengthens a deleted canonical card, even
            # when its old materialized metadata still says active.
            memory_id = cards[0]["id"]
            memories.update(where=f"id = '{memory_id}'", values={"status": "deleted"})
            reinforce_recall(domain, cards[:1])
            current = database.open_table("metadata").search().where(f"id = '{memory_id}'").to_list()[0]
            self.assertNotIn("retrievalCount", json.loads(current["metadataJson"]))

    def test_concurrent_agent_edit_wins_over_hourly_judgment(self):
        with tempfile.TemporaryDirectory() as root:
            domain = Plur1busDomain(Path(root), "main")
            binding = binding_from_scope("main")
            database = lancedb.connect(str(Path(root) / "lancedb/main"))
            memory_id = str(uuid.uuid4())
            metadata = {"text": "memo", "importance": 0.5, "importanceStatus": "pending", "scopeKey": binding.scope_key}
            table = database.create_table("metadata", data=[{"id": memory_id, "agentId": "main",
                "scopeKey": binding.scope_key, "metadataJson": json.dumps(metadata)}])
            memories = database.create_table("memories", data=[{"id": memory_id, "agentId": "main",
                "scopeKey": binding.scope_key, "status": "active", "content": "memo"}])
            class Backend:
                def available(self):
                    return True
                def complete_json(self, *args):
                    table.update(where=f"id = '{memory_id}'", values={"metadataJson": json.dumps({**metadata,
                        "importance": 0.97, "importanceStatus": "final", "coreMemoryReason": "manual_importance_marker"})})
                    return {"importance": 0.2}
            domain.set_llm_backend(Backend())
            result = run_encoding(domain, memories)
            self.assertEqual(result["refined"], 0)
            self.assertEqual(result["conflicts"], 1)
            row = database.open_table("metadata").to_arrow().to_pylist()[0]
            self.assertEqual(json.loads(row["metadataJson"])["importance"], 0.97)
