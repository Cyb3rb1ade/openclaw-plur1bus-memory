import tempfile
import unittest
import json
import uuid
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
from pathlib import Path

from plur1bus_hermes.runtime import Plur1busRuntime


class DurableMergeTests(unittest.TestCase):
    def test_explicit_repair_is_idempotent_and_keeps_source_until_apply(self):
        d, r = self.make()
        try:
            source = r._remember("alpha facts", "s", "user")
            p = r.create_merge_proposal("beta facts", "s")
            with patch.object(r._domain, "on_memory", side_effect=RuntimeError("crash")):
                with self.assertRaises(RuntimeError):
                    r.apply_merge_proposal(p["proposalId"], approved_revision=p["revision"])
            self.assertFalse(r.repair_merge_proposal(p["proposalId"], approved_revision="wrong"))
            self.assertTrue(r.repair_merge_proposal(p["proposalId"], approved_revision=p["revision"]))
            self.assertTrue(r.repair_merge_proposal(p["proposalId"], approved_revision=p["revision"]))
            table, _ = r._table(False)
            self.assertEqual(table.search().where(f"id = '{source}'").limit(1).to_list()[0]["status"], "active")
            selector = r._domain._scope_selector(acl_bindings=r.scope_binding)
            rows = r._domain._metadata_rows_for_scope(selector)
            self.assertEqual(sum(row["id"] == p["replacementId"] for row in rows), 1)
            self.assertTrue(r.apply_merge_proposal(p["proposalId"], approved_revision=p["revision"]))
        finally:
            r.shutdown(); d.cleanup()

    def test_repair_preserves_manual_mirror_and_source(self):
        d, r = self.make()
        try:
            source = r._remember("alpha facts", "s", "user")
            p = r.create_merge_proposal("beta facts", "s")
            with patch.object(r._domain, "on_memory", side_effect=RuntimeError("crash")):
                with self.assertRaises(RuntimeError):
                    r.apply_merge_proposal(p["proposalId"], approved_revision=p["revision"])
            self.assertTrue(r.repair_merge_proposal(p["proposalId"], approved_revision=p["revision"]))
            selector = r._domain._scope_selector(acl_bindings=r.scope_binding)
            note = r._domain._scope_workspace_dir(selector) / "plur1bus" / "memories" / f"{p['replacementId']}.md"
            note.write_text("manual text")
            self.assertFalse(r.repair_merge_proposal(p["proposalId"], approved_revision=p["revision"]))
            self.assertEqual(note.read_text(), "manual text")
            table, _ = r._table(False)
            self.assertEqual(table.search().where(f"id = '{source}'").limit(1).to_list()[0]["status"], "active")
        finally:
            r.shutdown(); d.cleanup()

    def test_missing_approval_and_symlink_alias_refused(self):
        d, r = self.make()
        try:
            r._remember("alpha facts", "s", "user")
            p = r.create_merge_proposal("beta facts", "s")
            self.assertFalse(r.apply_merge_proposal(p["proposalId"]))
            directory = r.data_dir / "state" / "merge-proposals"
            alias = str(uuid.uuid4())
            (directory / f"{alias}.json").symlink_to(directory / f"{p['proposalId']}.json")
            self.assertFalse(r.apply_merge_proposal(alias, approved_revision=p["revision"]))
        finally:
            r.shutdown(); d.cleanup()

    def test_two_runtime_instances_share_one_replacement(self):
        d, r = self.make()
        other = Plur1busRuntime(Path(d.name), r.config, "main")
        other._embedding.embed = r._embedding.embed
        other._domain.on_memory = r._domain.on_memory
        try:
            r._remember("alpha facts", "s", "user")
            p = r.create_merge_proposal("beta facts", "s")
            with ThreadPoolExecutor(2) as pool:
                jobs = [pool.submit(runtime.apply_merge_proposal, p["proposalId"],
                                    approved_revision=p["revision"]) for runtime in (r, other)]
                self.assertTrue(all(job.result(timeout=5) for job in jobs))
            table, _ = r._table(False)
            self.assertEqual(len(table.search().where(f"id = '{p['replacementId']}'").limit(3).to_list()), 1)
        finally:
            other.shutdown(); r.shutdown(); d.cleanup()

    def test_crash_after_source_retirement_recovers_and_missing_replacement_fails(self):
        d, r = self.make()
        try:
            r._remember("alpha facts", "s", "user")
            p = r.create_merge_proposal("beta facts", "s")
            from plur1bus_hermes.durable_merge import persist_proposal
            def interrupted(path, proposal):
                if proposal["state"] == "applied":
                    raise RuntimeError("simulated acknowledgement crash")
                persist_proposal(path, proposal)
            with patch("plur1bus_hermes.runtime.persist_proposal", side_effect=interrupted):
                with self.assertRaises(RuntimeError):
                    r.apply_merge_proposal(p["proposalId"], approved_revision=p["revision"])
            self.assertTrue(r.apply_merge_proposal(p["proposalId"], approved_revision=p["revision"]))
            table, _ = r._table(False)
            table.delete(f"id = '{p['replacementId']}'")
            self.assertFalse(r.apply_merge_proposal(p["proposalId"], approved_revision=p["revision"]))
        finally:
            r.shutdown(); d.cleanup()

    def test_insert_without_materialization_never_retires_source(self):
        d, r = self.make()
        try:
            source = r._remember("alpha facts", "s", "user")
            p = r.create_merge_proposal("beta facts", "s")
            with patch.object(r._domain, "on_memory", side_effect=RuntimeError("materialization crash")):
                with self.assertRaises(RuntimeError):
                    r.apply_merge_proposal(p["proposalId"], approved_revision=p["revision"])
            self.assertFalse(r.apply_merge_proposal(p["proposalId"], approved_revision=p["revision"]))
            table, _ = r._table(False)
            self.assertEqual(table.search().where(f"id = '{source}'").limit(1).to_list()[0]["status"], "active")
            proposal = json.loads((r.data_dir / "state" / "merge-proposals" / f"{p['proposalId']}.json").read_text())
            self.assertEqual(proposal["state"], "repair_required")
        finally:
            r.shutdown(); d.cleanup()

    def make(self):
        d=tempfile.TemporaryDirectory(); r=Plur1busRuntime(Path(d.name), {"merging":{"enabled":True},"embedding":{"dimensions":2}}, "main")
        r._embedding.embed=lambda _t, purpose="passage":[.1,.2]
        r._domain.on_memory=lambda *_a,**_k:None
        return d,r
    def test_success_and_idempotent_retry(self):
        d,r=self.make()
        try:
            source=r._remember("alpha facts", "s", "user"); p=r.create_merge_proposal("beta facts", "s")
            self.assertIsNotNone(p); self.assertTrue(r.apply_merge_proposal(p["proposalId"], approved_revision=p["revision"])); self.assertTrue(r.apply_merge_proposal(p["proposalId"], approved_revision=p["revision"]))
            t,_=r._table(False); rows=t.search().limit(10).to_list(); merged=next(x for x in rows if x["id"]==p["replacementId"])
            self.assertIn(source, p["mergedFrom"]); self.assertEqual(merged["mergedFrom"], __import__('json').dumps(p["mergedFrom"]))
        finally: r.shutdown(); d.cleanup()
    def test_stale_source_conflicts(self):
        d,r=self.make()
        try:
            sid=r._remember("alpha facts", "s", "user"); p=r.create_merge_proposal("beta facts", "s")
            t,_=r._table(False); t.update(where=f"id = '{sid}'", values={"content":"changed"})
            self.assertFalse(r.apply_merge_proposal(p["proposalId"], approved_revision=p["revision"])); import json
            self.assertEqual(json.loads((r.data_dir/"state"/"merge-proposals"/(p["proposalId"]+".json")).read_text())["state"],"conflict")
        finally: r.shutdown(); d.cleanup()
    def test_disjoint_refused(self):
        d,r=self.make()
        try:
            r._remember("alpha facts","s","user",valid_from=100,valid_until=200)
            self.assertIsNone(r.create_merge_proposal("beta facts","s",valid_from=200,valid_until=300))
        finally: r.shutdown(); d.cleanup()
    def test_forged_revision_and_path_traversal_rejected(self):
        d,r=self.make()
        try:
            r._remember("alpha facts","s","user"); p=r.create_merge_proposal("beta facts","s")
            self.assertFalse(r.apply_merge_proposal(p["proposalId"], approved_revision="forged"))
            with self.assertRaises(ValueError): r.apply_merge_proposal("../" + p["proposalId"])
        finally: r.shutdown(); d.cleanup()
    def test_temporal_snapshot_mutation_conflicts(self):
        d,r=self.make()
        try:
            sid=r._remember("alpha facts","s","user",valid_from=100,valid_until=300); p=r.create_merge_proposal("beta facts","s",valid_from=100,valid_until=200)
            t,_=r._table(False); t.update(where=f"id = '{sid}'",values={"validUntil":301})
            self.assertFalse(r.apply_merge_proposal(p["proposalId"], approved_revision=p["revision"]))
        finally: r.shutdown(); d.cleanup()
    def test_prepared_retry_reuses_one_replacement_after_forget_failure(self):
        d,r=self.make()
        try:
            r._remember("alpha facts","s","user"); p=r.create_merge_proposal("beta facts","s")
            original=r.forget; r.forget=lambda _id: False
            self.assertFalse(r.apply_merge_proposal(p["proposalId"], approved_revision=p["revision"])); r.forget=original
            self.assertTrue(r.apply_merge_proposal(p["proposalId"], approved_revision=p["revision"]))
            t,_=r._table(False); self.assertEqual(len(t.search().where(f"id = '{p['replacementId']}'").limit(10).to_list()),1)
        finally: r.shutdown(); d.cleanup()
    def test_prepared_forged_lineage_cannot_retire_source(self):
        d,r=self.make()
        try:
            sid=r._remember("alpha facts","s","user"); p=r.create_merge_proposal("beta facts","s")
            r.forget=lambda _id: False; r.apply_merge_proposal(p["proposalId"], approved_revision=p["revision"])
            t,_=r._table(False); t.update(where=f"id = '{p['replacementId']}'",values={"mergedFrom":"[]"})
            self.assertFalse(r.apply_merge_proposal(p["proposalId"], approved_revision=p["revision"])); self.assertEqual(t.search().where(f"id = '{sid}'").limit(1).to_list()[0]["status"],"active")
        finally: r.shutdown(); d.cleanup()

    def test_repair_rejects_cross_scope_and_preserves_source(self):
        d, r = self.make()
        other = Plur1busRuntime(Path(d.name), r.config, "main", {"scopeType": "workspace", "workspace": "other"})
        other._embedding.embed = r._embedding.embed
        try:
            source = r._remember("alpha facts", "s", "user")
            proposal = r.create_merge_proposal("beta facts", "s")
            with patch.object(r._domain, "on_memory", side_effect=RuntimeError("crash")):
                with self.assertRaises(RuntimeError):
                    r.apply_merge_proposal(proposal["proposalId"], approved_revision=proposal["revision"])
            self.assertFalse(other.repair_merge_proposal(proposal["proposalId"], approved_revision=proposal["revision"]))
            table, _ = r._table(False)
            self.assertEqual(table.search().where(f"id = '{source}'").limit(1).to_list()[0]["status"], "active")
        finally:
            other.shutdown(); r.shutdown(); d.cleanup()

    def test_repair_rejects_stale_replacement_lineage_without_retiring_source(self):
        d, r = self.make()
        try:
            source = r._remember("alpha facts", "s", "user")
            proposal = r.create_merge_proposal("beta facts", "s")
            with patch.object(r._domain, "on_memory", side_effect=RuntimeError("crash")):
                with self.assertRaises(RuntimeError):
                    r.apply_merge_proposal(proposal["proposalId"], approved_revision=proposal["revision"])
            table, _ = r._table(False)
            table.update(where=f"id = '{proposal['replacementId']}'", values={"mergedFrom": "[]"})
            self.assertFalse(r.repair_merge_proposal(proposal["proposalId"], approved_revision=proposal["revision"]))
            self.assertEqual(table.search().where(f"id = '{source}'").limit(1).to_list()[0]["status"], "active")
        finally: r.shutdown(); d.cleanup()

if __name__ == '__main__': unittest.main()
