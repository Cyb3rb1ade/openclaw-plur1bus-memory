"""Operator-only workspace consent plans stay source and route bound."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from plur1bus_hermes.namespaces import ScopeBinding
from plur1bus_hermes.validation import ValidationError
from plur1bus_hermes.workspace_consent import (
    apply_workspace_consent,
    approve_workspace_consent,
    plan_workspace_consent,
    revoke_workspace_consent,
)


class WorkspaceConsentTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.source = self.root / "explicit-vault"
        self.source.mkdir()
        (self.source / "note.md").write_text("A user-provided workspace note.", encoding="utf-8")
        self.binding = ScopeBinding("main")
        self.runtime = SimpleNamespace(
            data_dir=self.root / "runtime-data",
            agent_id="main",
            scope_binding=self.binding,
            config={},
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_plan_binds_explicit_source_manifest_and_canonical_destination(self) -> None:
        plan = plan_workspace_consent(self.runtime, self.source)

        self.assertTrue(plan["dryRun"])
        self.assertEqual(plan["sourceManifest"]["source"], str(self.source.resolve()))
        self.assertEqual(plan["sourceRevision"], plan["sourceManifest"]["revision"])
        self.assertEqual(plan["destination"]["agentId"], "main")
        self.assertEqual(plan["destination"]["scopeKey"], self.binding.scope_key)
        self.assertEqual(plan["destination"]["dataRoute"], str(self.runtime.data_dir.resolve()))
        self.assertEqual(plan["destination"]["writerRoute"], {
            "name": "default",
            "path": str((self.runtime.data_dir / "lancedb" / "main").resolve()),
            "writable": True,
        })

    def test_exact_approval_applies_once_and_source_change_requires_new_consent(self) -> None:
        plan = plan_workspace_consent(self.runtime, self.source)
        approved = approve_workspace_consent(
            self.runtime, plan, approved_revision=plan["revision"]
        )
        self.assertTrue(approved["approved"])

        with patch("plur1bus_hermes.workspace_consent.apply_source_sync", return_value={"imported": ["id"]}) as apply:
            result = apply_workspace_consent(
                self.runtime, self.source, approved_revision=plan["revision"]
            )
        self.assertEqual(result["imported"], ["id"])
        apply.assert_called_once_with(
            self.runtime, plan["sourceManifest"], approved_revision=plan["sourceRevision"]
        )

        (self.source / "note.md").write_text("Changed after consent.", encoding="utf-8")
        with self.assertRaisesRegex(ValidationError, "new exact consent"):
            apply_workspace_consent(self.runtime, self.source, approved_revision=plan["revision"])

    def test_writer_namespace_change_invalidates_consent(self) -> None:
        plan = plan_workspace_consent(self.runtime, self.source)
        approve_workspace_consent(self.runtime, plan, approved_revision=plan["revision"])
        self.runtime.config = {
            "namespaces": {
                "activeWriteNamespace": "generation-two",
                "activeRecallNamespaces": ["generation-two"],
                "legacyReadOnlyNamespaces": [],
            },
        }

        with self.assertRaisesRegex(ValidationError, "new exact consent"):
            apply_workspace_consent(self.runtime, self.source, approved_revision=plan["revision"])

    def test_approval_requires_exact_revision_and_manual_record_conflict_fails_closed(self) -> None:
        plan = plan_workspace_consent(self.runtime, self.source)
        with self.assertRaisesRegex(ValidationError, "exact workspace consent revision"):
            approve_workspace_consent(self.runtime, plan, approved_revision="wrong")
        approve_workspace_consent(self.runtime, plan, approved_revision=plan["revision"])
        state_path = Path(plan["destination"]["consentStatePath"])
        state_path.write_text('{"manual":true}', encoding="utf-8")

        with self.assertRaisesRegex(ValidationError, "manually changed"):
            revoke_workspace_consent(self.runtime, self.source, approved_revision=plan["revision"])

    def test_source_and_record_symlinks_are_refused(self) -> None:
        source_link = self.root / "source-link"
        source_link.symlink_to(self.source, target_is_directory=True)
        with self.assertRaisesRegex(ValidationError, "non-symlink"):
            plan_workspace_consent(self.runtime, source_link)

        plan = plan_workspace_consent(self.runtime, self.source)
        approve_workspace_consent(self.runtime, plan, approved_revision=plan["revision"])
        state_path = Path(plan["destination"]["consentStatePath"])
        replacement = self.root / "manual-record.json"
        replacement.write_text("{}", encoding="utf-8")
        state_path.unlink()
        state_path.symlink_to(replacement)
        with self.assertRaisesRegex(ValidationError, "symlink"):
            revoke_workspace_consent(self.runtime, self.source, approved_revision=plan["revision"])

    def test_revocation_does_not_read_changed_source_and_blocks_apply(self) -> None:
        plan = plan_workspace_consent(self.runtime, self.source)
        approve_workspace_consent(self.runtime, plan, approved_revision=plan["revision"])
        # Revocation must remain possible after a source was modified or removed.
        (self.source / "note.md").unlink()
        self.source.rmdir()
        revoked = revoke_workspace_consent(
            self.runtime, self.source, approved_revision=plan["revision"]
        )
        self.assertTrue(revoked["revoked"])
        with self.assertRaises(ValidationError):
            apply_workspace_consent(self.runtime, self.source, approved_revision=plan["revision"])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
