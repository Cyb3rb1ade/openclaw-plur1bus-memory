"""Native workshop regressions for benefit, mining, retirement and apply retries."""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import Mock, patch

from plur1bus_hermes.namespaces import ScopeBinding
from plur1bus_hermes.skill_workshop import SkillWorkshop, _revision
from plur1bus_hermes.validation import ValidationError
from test_skill_workshop import _candidate, _row, _runtime


class _MutableQuery:
    def __init__(self, rows):
        self.rows = rows
        self.maximum = 100

    def where(self, clause):
        match = re.search(r"\bid = '((?:[^']|'')*)'", clause)
        if match:
            identifier = match[1].replace("''", "'")
            self.rows = [row for row in self.rows if row["id"] == identifier]
        after = re.search(r"\bid > '([^']+)'", clause)
        if after:
            self.rows = [row for row in self.rows if row["id"] > after[1]]
        return self

    def order_by(self, _ordering):
        self.rows = sorted(self.rows, key=lambda row: row["id"])
        return self

    def limit(self, maximum):
        self.maximum = maximum
        return self

    def to_list(self):
        return [dict(row) for row in self.rows[:self.maximum]]


class _MutableTable:
    def __init__(self, rows):
        self.rows = rows
        self.failures = set()
        self.updates = []

    def search(self):
        return _MutableQuery(self.rows)

    def update(self, *, where, values):
        identifier = re.search(r"\bid = '([^']+)'", where)[1]
        self.updates.append((identifier, where, values))
        if identifier in self.failures:
            self.failures.remove(identifier)
            raise OSError("transient promotion error")
        for row in self.rows:
            if row["id"] == identifier:
                row.update(values)


class WorkshopDeltaTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.binding = ScopeBinding("main")
        self.ids = [str(uuid.uuid4()) for _ in range(3)]
        self.rows = [_row(self.binding, identifier, epistemicStatus="observed") for identifier in self.ids]
        self.candidate = _candidate(evidence=self.ids)[0]
        self.candidate.update({"benefit": "Avoids repeated manual verification for the operator.",
                               "confidence": .85, "category": "workflow"})
        self.runtime = _runtime(self.root / "data", self.binding, self.rows, [self.candidate])
        self.table = _MutableTable(self.rows)
        self.runtime._table = lambda create=False: (self.table, False)
        self.backend = self.runtime._domain._llm_backend
        self.backend.complete_json = Mock(return_value={"candidates": [self.candidate]})
        self.workshop = SkillWorkshop(self.runtime)
        self.home = self.root / "hermes"

    def _mine(self):
        return self.workshop.mine()["proposals"][0]

    def _publish(self):
        proposal = self._mine()
        self.workshop.approve(proposal["id"], proposal["revision"])
        return proposal, self.workshop.publish(proposal["id"], proposal["revision"], self.home)

    def test_new_benefit_is_rendered_and_backfill_never_rewrites_approved_bytes(self):
        proposal, _ = self._publish()
        saved = self.workshop.inspect(proposal["id"])
        target = Path(saved["nativeSkill"])
        before = target.read_bytes()
        self.assertIn(self.candidate["benefit"].encode(), before)
        self.assertEqual(self.workshop.list()[0]["confidence"], .85)
        state = self.workshop._read()
        state[0]["benefit"] = ""
        self.workshop._write(state)
        self.backend.complete_json.return_value = {"benefit": "Saves future repeated checks."}
        self.assertEqual(self.workshop.backfill_benefits()["filled"], 1)
        self.assertEqual(self.workshop.inspect(proposal["id"])["revision"], proposal["revision"])
        self.assertEqual(target.read_bytes(), before)
        self.assertTrue(self.workshop.publish(proposal["id"], proposal["revision"], self.home)["idempotent"])

    def test_publication_writes_exact_utf8_bytes_even_with_windows_text_translation(self):
        self.candidate["instructions"] = "Prüfe die Quelle.\nKeep LF.\r\nPreserve reviewed CRLF too."
        original_fdopen = os.fdopen

        def windows_fdopen(fd, mode="r", *args, **kwargs):
            # Reproduce Windows TextIOWrapper translation on every CI host.
            if "b" not in mode and kwargs.get("newline") is None:
                kwargs["newline"] = "\r\n"
            return original_fdopen(fd, mode, *args, **kwargs)

        with patch("plur1bus_hermes.skill_workshop.os.fdopen", side_effect=windows_fdopen):
            proposal, _ = self._publish()
        saved = self.workshop.inspect(proposal["id"])
        expected = self.workshop._render_skill(saved).encode("utf-8")
        target = Path(saved["nativeSkill"])
        self.assertEqual(target.read_bytes(), expected)
        self.assertEqual(saved["publishedHash"], hashlib.sha256(expected).hexdigest())
        modified_at = target.stat().st_mtime_ns
        self.assertTrue(self.workshop.publish(proposal["id"], proposal["revision"], self.home)["idempotent"])
        self.assertEqual(target.stat().st_mtime_ns, modified_at)
        result = self.workshop.withdraw(proposal["id"], proposal["revision"], self.home)
        self.assertEqual(Path(result["archivePath"]).read_bytes(), expected)
        self.assertFalse(target.exists())

    def test_newline_only_manual_edits_are_not_normalized_away(self):
        proposal, _ = self._publish()
        saved = self.workshop.inspect(proposal["id"])
        target = Path(saved["nativeSkill"])
        edited = self.workshop._render_skill(saved).encode("utf-8").replace(b"\n", b"\r\n")
        target.write_bytes(edited)
        with self.assertRaisesRegex(ValidationError, "missing or was changed"):
            self.workshop.publish(proposal["id"], proposal["revision"], self.home)
        with self.assertRaisesRegex(ValidationError, "manual edits"):
            self.workshop.withdraw(proposal["id"], proposal["revision"], self.home)
        self.assertEqual(target.read_bytes(), edited)

    def test_legacy_revision_and_render_survive_backfill(self):
        proposal = self._mine()
        state = self.workshop._read()
        for key in ("revisionVersion", "renderedBenefit", "confidence", "category", "benefit"):
            state[0].pop(key, None)
        state[0]["revision"] = _revision(state[0])
        old_revision = state[0]["revision"]
        self.workshop._write(state)
        before = self.workshop._render_skill(state[0])
        self.workshop.approve(proposal["id"], old_revision)
        self.backend.complete_json.return_value = {"benefit": "An advisory benefit."}
        self.workshop.backfill_benefits()
        saved = self.workshop.inspect(proposal["id"])
        self.assertEqual(saved["revision"], old_revision)
        self.assertEqual(self.workshop._render_skill(saved), before)
        self.assertTrue(self.workshop.publish(proposal["id"], old_revision, self.home)["published"])

    def test_negative_memo_uses_exact_evidence_ids_and_content_hashes(self):
        self.backend.complete_json.return_value = {"candidates": []}
        self.assertEqual(self.workshop.mine()["created"], 0)
        self.assertEqual(SkillWorkshop(self.runtime).mine()["skippedKnownCluster"], 1)
        self.assertEqual(self.backend.complete_json.call_count, 1)
        self.rows[0]["content"] = "changed evidence, same identifier"
        self.workshop.mine()
        self.assertEqual(self.backend.complete_json.call_count, 2)
        self.rows[0]["id"] = str(uuid.uuid4())
        self.workshop.mine()
        self.assertEqual(self.backend.complete_json.call_count, 3)
        self.workshop._remember_cluster({str(index): "2000" for index in range(350)}, "new")
        self.assertEqual(len(self.workshop._memo()), 300)

    def test_backend_failure_and_disabled_backend_are_not_negative_memoized(self):
        self.backend.complete_json.side_effect = [OSError("offline"), {"candidates": []}]
        self.workshop.mine()
        self.workshop.mine()
        self.assertEqual(self.backend.complete_json.call_count, 2)
        self.assertEqual(self.workshop.mine()["skippedKnownCluster"], 1)

    def test_bounded_mining_progresses_past_memoized_first_batches(self):
        self.rows[:] = [_row(self.binding, str(uuid.UUID(int=index)), epistemicStatus="observed")
                        for index in range(1, 33)]
        def extract(_purpose, _instructions, payload):
            evidence = json.loads(payload.split("\n", 1)[1])
            return {"candidates": _candidate(title="Procedure " + evidence[0]["id"],
                                            evidence=[item["id"] for item in evidence[:3]])}
        self.backend.complete_json.side_effect = extract
        first = self.workshop.mine()
        self.assertEqual(first["backendCalls"], 3)
        self.assertEqual(first["created"], 3)
        second = self.workshop.mine()
        self.assertEqual(second["skippedKnownCluster"], 0)
        self.assertEqual(second["backendCalls"], 1)
        self.assertEqual(second["created"], 1)
        self.assertEqual(self.workshop.mine()["skippedKnownCluster"], 4)

    def test_persisted_keyset_cursor_reaches_all_104_rows_after_restart_and_rolls_over(self):
        self.rows[:] = [_row(self.binding, str(uuid.UUID(int=index)), epistemicStatus="observed")
                        for index in range(1, 105)]
        self.rows.reverse()  # Physical storage order must not decide keyset progress.
        seen = set()
        def extract(_purpose, _instructions, payload):
            evidence = json.loads(payload.split("\n", 1)[1])
            self.assertLessEqual(len(evidence), 8)
            seen.update(item["id"] for item in evidence)
            return {"candidates": []}
        self.backend.complete_json.side_effect = extract
        results = [SkillWorkshop(self.runtime).mine() for _ in range(5)]
        self.assertEqual(seen, {row["id"] for row in self.rows})
        self.assertTrue(all(result["backendCalls"] <= 3 and result["scanned"] <= 100 for result in results))
        self.assertTrue(results[-1]["scanRollover"])
        self.assertEqual(self.workshop._mining_cursor(), "")
        # A later insert whose ID sorts before the cursor is found after rollover.
        earlier = _row(self.binding, str(uuid.UUID(int=0)), epistemicStatus="observed")
        self.rows.append(earlier)
        for _ in range(6):
            SkillWorkshop(self.runtime).mine()
        self.assertIn(earlier["id"], seen)

    def test_failed_cluster_keeps_cursor_before_its_ids_and_is_retried_first(self):
        self.rows[:] = [_row(self.binding, str(uuid.UUID(int=index)), epistemicStatus="observed")
                        for index in range(1, 33)]
        calls = []
        def extract(_purpose, _instructions, payload):
            ids = [item["id"] for item in json.loads(payload.split("\n", 1)[1])]
            calls.append(ids)
            if len(calls) == 2:
                raise OSError("temporary model failure")
            return {"candidates": []}
        self.backend.complete_json.side_effect = extract
        failed = self.workshop.mine()
        self.assertEqual(failed["backendCalls"], 2)
        self.assertEqual(failed["scanCursor"], str(uuid.UUID(int=8)))
        resumed = SkillWorkshop(self.runtime).mine()
        self.assertEqual(calls[1], calls[2])
        self.assertEqual(resumed["backendCalls"], 3)
        self.assertTrue(resumed["scanRollover"])
        self.assertEqual(len(set(identifier for batch in calls for identifier in batch)), 32)

    def test_scanning_advances_across_ineligible_pages_and_deleted_cursor(self):
        self.rows[:] = [_row(self.binding, str(uuid.UUID(int=index)), epistemicStatus="untrusted")
                        for index in range(1, 101)]
        self.rows.extend(_row(self.binding, str(uuid.UUID(int=index)), epistemicStatus="observed")
                         for index in range(101, 105))
        self.backend.complete_json.return_value = {"candidates": []}
        first = self.workshop.mine()
        self.assertEqual(first["backendCalls"], 0)
        self.assertEqual(first["scanCursor"], str(uuid.UUID(int=100)))
        self.rows[:] = [row for row in self.rows if row["id"] != str(uuid.UUID(int=100))]
        second = SkillWorkshop(self.runtime).mine()
        self.assertEqual(second["backendCalls"], 1)
        self.assertTrue(second["scanRollover"])

    def test_cursor_cannot_be_transplanted_from_another_scope(self):
        self.workshop._write_mining_cursor(self.ids[0])
        path = self.workshop._path("mining-cursor.json")
        payload = json.loads(path.read_text())
        payload["scopeKey"] = "another-scope"
        path.write_text(json.dumps(payload), encoding="utf-8")
        with self.assertRaisesRegex(ValidationError, "invalid scope"):
            self.workshop.mine()
        self.backend.complete_json.assert_not_called()

    def test_exact_evidence_lookup_survives_more_than_one_hundred_new_captures(self):
        proposal = self._mine()
        self.rows[:0] = [_row(self.binding, str(uuid.uuid4()), epistemicStatus="observed") for _ in range(150)]
        self.assertTrue(self.workshop.approve(proposal["id"], proposal["revision"])["approved"])
        self.assertTrue(self.workshop.publish(proposal["id"], proposal["revision"], self.home)["published"])

    def test_opaque_document_ids_after_100_rows_are_reviewable_but_never_promoted(self):
        self.rows[:] = [_row(self.binding, str(uuid.UUID(int=index)), epistemicStatus="untrusted")
                        for index in range(1, 101)]
        opaque_ids = ["document-101", "document-102", "document-'103"]
        self.rows.extend(_row(self.binding, identifier, epistemicStatus="observed") for identifier in opaque_ids)
        self.candidate["evidenceIds"] = opaque_ids
        self.assertEqual(self.workshop.mine()["backendCalls"], 0)
        proposal = self.workshop.mine()["proposals"][0]
        self.assertTrue(self.workshop.approve(proposal["id"], proposal["revision"])["approved"])
        published = self.workshop.publish(proposal["id"], proposal["revision"], self.home)
        self.assertFalse(published["activationPartial"])
        self.assertTrue(all(result["note"] == "non_uuid_id" for result in published["evidencePromotion"].values()))
        self.assertEqual(self.table.updates, [])

    def test_duplicate_or_rescoped_opaque_evidence_cannot_approve(self):
        self.rows[:] = [_row(self.binding, identifier) for identifier in ("doc-a", "doc-b")]
        self.candidate["evidenceIds"] = ["doc-a", "doc-b"]
        proposal = self._mine()
        self.rows.append(dict(self.rows[0]))
        with self.assertRaisesRegex(ValidationError, "evidence changed"):
            self.workshop.approve(proposal["id"], proposal["revision"])
        self.rows.pop()
        self.rows[0]["scopeKey"] = "other-scope"
        with self.assertRaisesRegex(ValidationError, "evidence changed"):
            self.workshop.approve(proposal["id"], proposal["revision"])

    def test_expired_or_invalidated_evidence_vetoes_approval(self):
        proposal = self._mine()
        for values in ({"expiresAt": 1}, {"epistemicStatus": "invalidated"}, {"epistemicStatus": "disputed"}):
            with self.subTest(values=values):
                self.rows[0].update(values)
                with self.assertRaisesRegex(ValidationError, "evidence changed"):
                    self.workshop.approve(proposal["id"], proposal["revision"])
                self.rows[0].update({"expiresAt": 0, "epistemicStatus": "observed"})

    def test_reject_keeps_review_material_and_blocks_same_skill_name(self):
        proposal = self._mine()
        with self.assertRaises(ValidationError):
            self.workshop.reject(proposal["id"], "0" * 64)
        self.assertTrue(self.workshop.reject(proposal["id"], proposal["revision"])["rejected"])
        self.assertTrue(self.workshop.reject(proposal["id"], proposal["revision"])["idempotent"])
        self.rows[0]["content"] += " additional evidence"
        self.assertEqual(self.workshop.mine()["skippedDuplicate"], 1)
        self.assertEqual(self.workshop.inspect(proposal["id"])["instructions"], self.candidate["instructions"])
        with self.assertRaises(ValidationError):
            self.workshop.approve(proposal["id"], proposal["revision"])
        self.assertTrue(self.workshop._path("operations.audit.jsonl").is_file())

    def test_withdraw_requires_exact_hash_and_archives_only_owned_skill_file(self):
        proposal, _ = self._publish()
        target = Path(self.workshop.inspect(proposal["id"])["nativeSkill"])
        original = target.read_bytes()
        target.write_text("manual edit", encoding="utf-8")
        with self.assertRaisesRegex(ValidationError, "manual edits"):
            self.workshop.withdraw(proposal["id"], proposal["revision"], self.home)
        self.assertEqual(target.read_text(), "manual edit")
        target.write_bytes(original)
        sibling = target.parent / "manual-notes.txt"
        sibling.write_text("preserve", encoding="utf-8")
        with self.assertRaisesRegex(ValidationError, "published profile"):
            self.workshop.withdraw(proposal["id"], proposal["revision"], self.root / "other")
        result = self.workshop.withdraw(proposal["id"], proposal["revision"], self.home)
        self.assertFalse(target.exists())
        self.assertTrue(sibling.is_file())
        self.assertEqual(Path(result["archivePath"]).read_bytes(), original)
        self.assertTrue(self.workshop.withdraw(proposal["id"], proposal["revision"], self.home)["idempotent"])

    def test_symlink_skill_directory_is_never_used(self):
        proposal = self._mine()
        self.workshop.approve(proposal["id"], proposal["revision"])
        self.home.mkdir()
        other = self.root / "redirected"
        other.mkdir()
        (self.home / "skills").symlink_to(other, target_is_directory=True)
        with self.assertRaisesRegex(ValidationError, "symlinks"):
            self.workshop.publish(proposal["id"], proposal["revision"], self.home)
        self.assertEqual(list(other.iterdir()), [])

    def test_published_partial_promotion_retries_failed_evidence_without_rewriting_skill(self):
        self.table.failures.add(self.ids[0])
        proposal, first = self._publish()
        self.assertTrue(first["activationPartial"])
        target = Path(self.workshop.inspect(proposal["id"])["nativeSkill"])
        before = target.stat().st_mtime_ns
        second = self.workshop.publish(proposal["id"], proposal["revision"], self.home)
        self.assertFalse(second["activationPartial"])
        self.assertEqual(target.stat().st_mtime_ns, before)
        self.assertEqual([identifier for identifier, _, _ in self.table.updates].count(self.ids[0]), 2)
        self.assertTrue(all(row["epistemicStatus"] == "corroborated" for row in self.rows))
        self.assertTrue(all("scopeKey" in where and "content =" in where for _, where, _ in self.table.updates))

    def test_table_open_failure_after_publication_leaves_visible_retry_marker(self):
        with patch.object(self.workshop, "_promote_evidence", side_effect=OSError("table unavailable")):
            proposal, result = self._publish()
        self.assertTrue(result["activationPartial"])
        self.assertTrue(self.workshop.inspect(proposal["id"])["activationPartial"])
        self.assertFalse(self.workshop.publish(proposal["id"], proposal["revision"], self.home)["activationPartial"])

    def test_blank_human_evidence_is_observed_once_and_non_uuid_ids_skip(self):
        for row in self.rows:
            row["epistemicStatus"] = ""
        self.rows[2]["id"] = "a" * 32
        self.candidate["evidenceIds"][2] = "a" * 32
        proposal, result = self._publish()
        self.assertEqual(result["evidencePromotion"]["a" * 32]["note"], "non_uuid_id")
        self.assertEqual(self.rows[0]["epistemicStatus"], "observed")
        self.workshop.publish(proposal["id"], proposal["revision"], self.home)
        self.assertEqual(self.rows[0]["epistemicStatus"], "observed")
        self.assertEqual(len(self.table.updates), 2)

    def test_committed_transition_with_failed_domain_audit_is_recovered_on_retry(self):
        for row in self.rows:
            row["epistemicStatus"] = ""
        failed_once = set()
        def audit(entry):
            if entry["event"] == "skill-workshop.evidence.promoted" and entry["memoryId"] not in failed_once:
                failed_once.add(entry["memoryId"])
                raise OSError("audit write temporarily failed")
        self.runtime._domain.audit_mutation = Mock(side_effect=audit)
        proposal, result = self._publish()
        self.assertTrue(result["activationPartial"])
        self.assertEqual(len(self.table.updates), 3)
        result = self.workshop.publish(proposal["id"], proposal["revision"], self.home)
        self.assertFalse(result["activationPartial"])
        self.assertEqual(len(self.table.updates), 3)
        self.assertTrue(all(row["epistemicStatus"] == "observed" for row in self.rows))
        self.assertTrue(any(call.args[0].get("recovered") for call in self.runtime._domain.audit_mutation.call_args_list))

    def test_explicit_auto_apply_uses_bound_home_and_system_corroboration(self):
        self.runtime.config["skillWorkshop"]["autoApply"] = "on"
        result = self.workshop.mine(hermes_home=self.home)
        self.assertEqual(result["autoApplied"], 1)
        self.assertEqual(result["proposals"][0]["status"], "published")
        self.assertTrue(all(row["epistemicStatus"] == "corroborated" for row in self.rows))
        self.assertTrue(all(change[2] == {"epistemicStatus": "corroborated"} for change in self.table.updates))

    def test_auto_apply_is_manual_without_host_policy_home_or_trusted_evidence(self):
        for mode, has_home, confidence, status, evidence_count in [
            ("host", True, .9, "observed", 3), ("on", False, .9, "observed", 3),
            ("on", True, .4, "observed", 3), ("on", True, .9, "", 3),
            ("on", True, .9, "observed", 2), (True, True, .9, "observed", 3),
        ]:
            with self.subTest(mode=mode, has_home=has_home, confidence=confidence, status=status, evidence_count=evidence_count):
                root = self.root / str(uuid.uuid4())
                rows = [_row(self.binding, str(uuid.uuid4()), epistemicStatus=status) for _ in range(evidence_count)]
                candidate = {**self.candidate, "confidence": confidence, "evidenceIds": [row["id"] for row in rows]}
                runtime = _runtime(root / "data", self.binding, rows, [candidate])
                runtime.config["skillWorkshop"]["autoApply"] = mode
                result = SkillWorkshop(runtime).mine(hermes_home=root / "home" if has_home else None)
                self.assertEqual(result["autoApplied"], 0)
                self.assertEqual(result["proposals"][0]["status"], "pending_review")
                self.assertFalse((root / "home" / "skills").exists())

    def test_untrusted_records_are_never_promoted_or_mined(self):
        for row in self.rows:
            row["epistemicStatus"] = "untrusted"
        self.runtime.config["skillWorkshop"]["autoApply"] = "on"
        self.assertEqual(self.workshop.mine(hermes_home=self.home)["created"], 0)
        self.assertEqual(self.table.updates, [])

    def test_interrupted_file_publication_cannot_be_rejected_or_moved_to_other_profile(self):
        proposal = self._mine()
        self.workshop.approve(proposal["id"], proposal["revision"])
        with patch.object(self.workshop, "_complete_publication", side_effect=OSError("state failed")):
            with self.assertRaises(OSError):
                self.workshop.publish(proposal["id"], proposal["revision"], self.home)
        with self.assertRaisesRegex(ValidationError, "withdraw"):
            self.workshop.reject(proposal["id"], proposal["revision"])
        with self.assertRaisesRegex(ValidationError, "different profile"):
            self.workshop.publish(proposal["id"], proposal["revision"], self.root / "other")
        self.assertTrue(self.workshop.withdraw(proposal["id"], proposal["revision"], self.home)["withdrawn"])

    def test_benefit_limit_and_malformed_optional_metadata_are_bounded(self):
        self.candidate.update({"category": [], "confidence": float("nan"), "benefit": {"invalid": True}})
        proposal = self._mine()
        saved = self.workshop.inspect(proposal["id"])
        self.assertEqual(saved["benefit"], "")
        self.assertEqual(saved["category"], "workflow")
        self.assertIsNone(saved["confidence"])
        with self.assertRaises(ValidationError):
            self.workshop.backfill_benefits(limit=101)
        self.backend.complete_json.return_value = {"benefit": "x" * 900}
        self.workshop.backfill_benefits()
        self.assertEqual(len(self.workshop.inspect(proposal["id"])["benefit"]), 400)


if __name__ == "__main__":
    unittest.main()
