import unittest
import tempfile
import uuid
from pathlib import Path

from plur1bus_hermes.critical import find_covered_chunk_ids
from plur1bus_hermes.domain import Plur1busDomain
from plur1bus_hermes.namespaces import ScopeBinding
from plur1bus_hermes.runtime import Plur1busRuntime


class CriticalChunkCoverageTests(unittest.TestCase):
    def test_only_same_turn_whole_covers_group_when_half_of_parts_match(self):
        parts = [
            {"id": "p1", "content": "Praxissoftware ist CGM-Medico", "chunkGroupId": "g", "sourceTurnId": "t"},
            {"id": "p2", "content": "Christian nutzt sie seit 2019", "chunkGroupId": "g", "sourceTurnId": "t"},
            {"id": "p3", "content": "Support am Vormittag", "chunkGroupId": "g", "sourceTurnId": "t"},
        ]
        whole = {"id": "w", "content": "Praxissoftware ist CGM Medico; Christian nutzt sie seit 2019.", "sourceTurnId": "t"}
        self.assertEqual(find_covered_chunk_ids([whole, *parts]), {"p1", "p2", "p3"})

    def test_chunks_only_different_turn_and_missing_turn_are_not_covered(self):
        parts = [
            {"id": "p1", "content": "one two", "chunkGroupId": "g", "sourceTurnId": "t"},
            {"id": "p2", "content": "three four", "chunkGroupId": "g", "sourceTurnId": "t"},
        ]
        self.assertEqual(find_covered_chunk_ids(parts), set())
        other_turn = {"id": "w", "content": "one two three four", "sourceTurnId": "other"}
        self.assertEqual(find_covered_chunk_ids([*parts, other_turn]), set())
        no_turn = {"id": "w", "content": "one two three four", "sourceTurnId": ""}
        self.assertEqual(find_covered_chunk_ids([*parts, no_turn]), set())

    def test_capture_uses_complete_group_not_inserted_prefix(self):
        with tempfile.TemporaryDirectory() as temporary:
            domain = Plur1busDomain(Path(temporary), "main")
            selector = domain._scope_selector()
            turn = "turn-complete-plan"
            texts = ["Never forget alpha detail", "beta information", "gamma information", "delta information"]
            context = [{"id": f"part-{index}", "content": text, "sourceTurnId": turn,
                        "chunkGroupId": "group", "sourceRole": "user", "status": "active",
                        "agentId": "main", "scopeKey": selector.scope_key,
                        "scopeType": selector.scope_type, "aclBindings": selector.acl_bindings}
                       for index, text in enumerate(texts)]
            context.insert(0, {"id": "whole", "content": texts[0], "sourceTurnId": turn,
                               "chunkGroupId": "", "sourceRole": "user", "status": "active",
                               "agentId": "main", "scopeKey": selector.scope_key,
                               "scopeType": selector.scope_type, "aclBindings": selector.acl_bindings})
            # The first chunk is already covered by the persisted prefix, but
            # the complete 4-part group has only 1/4 hits and must be classified.
            domain._memory_rows = lambda: [context[0], context[1]]
            domain._classify_materialized_memory(context[1], {}, selector,
                                                critical_group_context=context)
            classifications = domain._read_jsonl(domain._scope_state_dir(selector) / "critical-classification.jsonl")
            pushes = domain._read_jsonl(domain._scope_state_dir(selector) / "critical-push.jsonl")
            self.assertEqual([item["id"] for item in classifications], ["part-0"])
            self.assertEqual([item["id"] for item in pushes], ["part-0"])

    def test_runtime_propagates_full_capture_plan_before_sequential_materialization(self):
        with tempfile.TemporaryDirectory() as temporary:
            binding = ScopeBinding("main")
            runtime = object.__new__(Plur1busRuntime)
            runtime.config = {"captureChunking": True, "captureChunkingMode": "beides"}
            runtime.agent_id = "main"
            runtime.scope_key = binding.scope_key
            runtime.scope_binding = binding
            runtime.request_scope = {}
            runtime.data_dir = Path(temporary)
            runtime._epistemic_cutoff = {"ok": True}
            runtime._domain = type("DomainStub", (), {"on_turn": lambda self, *args, **kwargs: None})()
            captured = []
            runtime._remember = lambda content, session_id, source_role, **kwargs: captured.append(
                (content, session_id, source_role, kwargs)
            )
            message = "Never forget alpha.\n\nbeta note.\n\ngamma note.\n\ndelta note."
            runtime._capture_turn(message, "", "session", capture_id=str(uuid.uuid4()))
            user_rows = [row for row in captured if row[2] == "user" and row[0]]
            self.assertEqual(len(user_rows), 5)
            plan = user_rows[1][3]["critical_group_context"]
            self.assertEqual(len(plan), 5)
            self.assertEqual({row["id"] for row in plan}, {row[3]["record_id"] for row in user_rows})
            self.assertTrue(all(row[3]["critical_group_context"] is plan for row in user_rows))

    def test_half_coverage_and_foreign_scope_wholes(self):
        with tempfile.TemporaryDirectory() as temporary:
            domain = Plur1busDomain(Path(temporary), "main")
            selector = domain._scope_selector()
            turn = "turn-scope-plan"
            texts = ["Never forget alpha detail", "beta information", "gamma information", "delta information"]
            parts = [{"id": f"part-{index}", "content": text, "sourceTurnId": turn,
                      "chunkGroupId": "group", "sourceRole": "user", "status": "active",
                      "agentId": "main", "scopeKey": selector.scope_key,
                      "scopeType": selector.scope_type, "aclBindings": selector.acl_bindings}
                     for index, text in enumerate(texts)]
            whole = {"id": "whole", "content": " ".join(texts[:2]), "sourceTurnId": turn,
                     "chunkGroupId": "", "sourceRole": "user", "status": "active",
                     "agentId": "main", "scopeKey": selector.scope_key,
                     "scopeType": selector.scope_type, "aclBindings": selector.acl_bindings}
            complete = [whole, *parts]
            self.assertEqual(find_covered_chunk_ids(complete), {f"part-{index}" for index in range(4)})
            domain._classify_materialized_memory(parts[0], {}, selector, critical_group_context=complete)
            ledger_path = domain._scope_state_dir(selector) / "critical-classification.jsonl"
            classifications = domain._read_jsonl(ledger_path)
            self.assertEqual([item["id"] for item in classifications], ["part-0"])
            self.assertEqual(classifications[0]["reason"], "covered_chunk")
            self.assertEqual(classifications[0]["classificationStatus"], "skipped")
            self.assertFalse(classifications[0]["eligible"])
            self.assertEqual(parts[0]["content"], texts[0])
            self.assertEqual(parts[0]["status"], "active")
            # A materialization repair after the whole is gone has no complete
            # plan. The scoped ledger makes it idempotent and prevents a retry.
            domain._classify_materialized_memory(parts[0], {}, selector)
            self.assertEqual(len(domain._read_jsonl(ledger_path)), 1)

            foreign = {**whole, "id": "foreign-whole", "scopeKey": "foreign-scope",
                       "aclBindings": {**selector.acl_bindings, "scopeKey": "foreign-scope"},
                       "content": " ".join(texts)}
            isolated_parts = [{**part, "id": f"isolated-{index}"} for index, part in enumerate(parts)]
            isolated = [foreign, *isolated_parts]
            domain._classify_materialized_memory(isolated_parts[0], {}, selector, critical_group_context=isolated)
            classifications = domain._read_jsonl(domain._scope_state_dir(selector) / "critical-classification.jsonl")
            self.assertEqual({item["id"] for item in classifications}, {"part-0", "isolated-0"})


if __name__ == "__main__":
    unittest.main()
