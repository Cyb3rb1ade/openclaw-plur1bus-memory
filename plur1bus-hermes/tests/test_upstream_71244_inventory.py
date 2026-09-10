"""Regression gate for the pinned 7.12.44 upstream inventory."""

from __future__ import annotations

import hashlib
import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
AUDIT_PATH = ROOT / "docs/audits/hermes-7.12.44-delta.json"
UPSTREAM_BASE = "v7.12.7"
UPSTREAM_HEAD = "a3f48f28ac647e81c5260e8a1dbab7977bf9fb51"
HERMES_BASE = "c12ec2bba63d74ac8add8782ab6761472b4149c6"
ALLOWED_NATIVE_STATUSES = {"unreviewed", "partial", "verified", "host-specific"}
AUDIT_METADATA_FIELDS = {"auditStatus", "auditEvidence", "auditTests"}
ALLOWED_AUDIT_STATUSES = {"unreviewed", "partial", "verified", "host-specific"}


def git_output(*arguments: str) -> str:
    """Return text output from Git at the repository root."""
    return subprocess.check_output(["git", *arguments], cwd=ROOT, text=True)


class Upstream71244InventoryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.data = json.loads(AUDIT_PATH.read_text(encoding="utf-8"))

    @staticmethod
    def _pinned_legacy_groups() -> dict[str, list[dict[str, str]]]:
        """Load historical source rows from the fixed Hermes baseline only."""
        source = git_output(
            "show", HERMES_BASE + ":plur1bus-hermes/src/plur1bus_hermes/parity.py"
        )
        baseline = {"__name__": "pinned_baseline_parity"}
        exec(compile(source, "pinned_baseline_parity.py", "exec"), baseline)
        return {
            name: list(baseline[name])
            for name in ("FEATURES", "COVERAGE_710", "COVERAGE_712")
        }

    def _assert_audit_metadata(self, row: dict[str, object]) -> None:
        """Require evidence before a historical snapshot's audit progresses."""
        self.assertTrue(AUDIT_METADATA_FIELDS <= set(row))
        self.assertIn(row["auditStatus"], ALLOWED_AUDIT_STATUSES)
        self._assert_nonblank_string_list(row["auditEvidence"])
        self._assert_nonblank_string_list(row["auditTests"])
        if row["auditStatus"] == "unreviewed":
            self.assertFalse(row["auditEvidence"])
            self.assertFalse(row["auditTests"])
        else:
            self.assertTrue(row["auditEvidence"])
        if row["auditStatus"] == "verified":
            self.assertTrue(row["auditTests"])

    def _assert_nonblank_string_list(self, values: object) -> None:
        """Reject blank or non-string proof entries without coercion."""
        self.assertIsInstance(values, list)
        self.assertTrue(
            all(isinstance(item, str) and item.strip() for item in values)
        )

    def _assert_verified_commit_proofs(self, row: dict[str, object]) -> None:
        """Require nonblank evidence and tests for a verified commit row."""
        if row["nativeStatus"] == "verified":
            self.assertTrue(row["nativeEvidence"])
            self.assertTrue(row["tests"])
            self._assert_nonblank_string_list(row["nativeEvidence"])
            self._assert_nonblank_string_list(row["tests"])

    def _assert_legacy_row(
        self, actual: dict[str, object], expected: dict[str, str]
    ) -> None:
        """Check immutable source fields independently from audit metadata."""
        self.assertEqual(set(actual), set(expected) | AUDIT_METADATA_FIELDS)
        self.assertEqual(
            {key: value for key, value in actual.items() if key not in AUDIT_METADATA_FIELDS},
            expected,
        )
        self._assert_audit_metadata(actual)

    def test_inventory_covers_every_nonmerge_commit(self) -> None:
        expected = set(
            git_output("rev-list", "--no-merges", f"{UPSTREAM_BASE}..{self.data['upstreamHead']}").splitlines()
        )
        self.assertEqual({row["sha"] for row in self.data["commits"]}, expected)
        self.assertEqual(len(self.data["commits"]), len(expected))
        self.assertTrue(
            all(row["nativeStatus"] in ALLOWED_NATIVE_STATUSES for row in self.data["commits"])
        )
        for row in self.data["commits"]:
            self.assertIsInstance(row["sha"], str)
            self.assertIsInstance(row["subject"], str)
            self.assertEqual(
                row["subject"], git_output("show", "-s", "--format=%s", row["sha"]).rstrip("\n")
            )
            self.assertIsInstance(row["files"], list)
            self.assertIsInstance(row["nativeEvidence"], list)
            self.assertIsInstance(row["tests"], list)
            self._assert_verified_commit_proofs(row)

    def test_pinned_refs_and_changed_files_are_git_derived(self) -> None:
        self.assertEqual(self.data["upstreamBase"], UPSTREAM_BASE)
        self.assertEqual(self.data["upstreamHead"], UPSTREAM_HEAD)
        self.assertEqual(self.data["hermesBase"], HERMES_BASE)
        expected_files = set(git_output("diff", "--name-only", UPSTREAM_BASE, UPSTREAM_HEAD).splitlines())
        self.assertEqual(set(self.data["changedFiles"]), expected_files)
        self.assertEqual(len(self.data["changedFiles"]), len(expected_files))

    def test_legacy_inventory_preserves_all_pinned_source_groups(self) -> None:
        expected_groups = self._pinned_legacy_groups()
        self.assertEqual(set(self.data["legacyFeatures"]), set(expected_groups))
        for source_group, expected_rows in expected_groups.items():
            actual_rows = self.data["legacyFeatures"][source_group]
            self.assertEqual(len(actual_rows), len(expected_rows))
            for actual, expected in zip(actual_rows, expected_rows, strict=True):
                self._assert_legacy_row(actual, expected)

    def test_audit_metadata_permits_evidenced_current_status_without_changing_history(self) -> None:
        expected = self._pinned_legacy_groups()["FEATURES"][0]
        audited = {
            **expected,
            "auditStatus": "verified",
            "auditEvidence": ["reachable native call path reviewed"],
            "auditTests": ["test_native_call_path"],
        }
        self._assert_legacy_row(audited, expected)

    def test_audit_metadata_rejects_changed_historical_source_fields(self) -> None:
        expected = self._pinned_legacy_groups()["FEATURES"][0]
        altered = {
            **expected,
            "status": "ready",
            "auditStatus": "verified",
            "auditEvidence": ["reachable native call path reviewed"],
            "auditTests": ["test_native_call_path"],
        }
        with self.assertRaises(AssertionError):
            self._assert_legacy_row(altered, expected)

    def test_audit_metadata_rejects_blank_or_non_string_proof_items(self) -> None:
        expected = self._pinned_legacy_groups()["FEATURES"][0]
        for field, invalid in (("auditEvidence", "  "), ("auditTests", 7)):
            with self.subTest(field=field, invalid=invalid):
                audited = {
                    **expected,
                    "auditStatus": "verified",
                    "auditEvidence": ["reachable native call path reviewed"],
                    "auditTests": ["test_native_call_path"],
                }
                audited[field] = [invalid]
                with self.assertRaises(AssertionError):
                    self._assert_legacy_row(audited, expected)

    def test_verified_commit_rejects_blank_or_non_string_proof_items(self) -> None:
        for field, invalid in (("nativeEvidence", "  "), ("tests", 7)):
            with self.subTest(field=field, invalid=invalid):
                commit = {
                    "nativeStatus": "verified",
                    "nativeEvidence": ["reachable native call path reviewed"],
                    "tests": ["test_native_call_path"],
                }
                commit[field] = [invalid]
                with self.assertRaises(AssertionError):
                    self._assert_verified_commit_proofs(commit)

    def test_preservation_hashes_are_read_from_the_immutable_hermes_baseline(self) -> None:
        preservation = self.data["hermesPreservation"]
        self.assertEqual(preservation["baseline"], HERMES_BASE)
        records = preservation["files"]
        paths = {record["path"] for record in records}
        self.assertEqual(len(records), len(paths))
        required_prefixes = (
            "distribution/",
            "hermes-dashboard/",
            "plur1bus-hermes/",
            "plur1bus-controls/",
        )
        for prefix in required_prefixes:
            self.assertTrue(any(path.startswith(prefix) for path in paths), prefix)
        self.assertIn("scripts/.npmignore", paths)
        expected_host_installer_scripts = {
            path
            for path in git_output(
                "diff", "--name-only", UPSTREAM_BASE, HERMES_BASE, "--", "scripts"
            ).splitlines()
            if path != "scripts/.npmignore"
        }
        self.assertEqual(
            set(preservation["modifiedHermesHostInstallerScripts"]), expected_host_installer_scripts
        )
        expected_paths = {
            path
            for path in git_output("ls-tree", "-r", "--name-only", HERMES_BASE).splitlines()
            if path.startswith(required_prefixes)
        }
        expected_paths.update({"scripts/.npmignore", *expected_host_installer_scripts})
        self.assertEqual(paths, expected_paths)
        for record in records:
            baseline_bytes = subprocess.check_output(
                ["git", "show", f"{HERMES_BASE}:{record['path']}"], cwd=ROOT
            )
            self.assertEqual(record["sha256"], hashlib.sha256(baseline_bytes).hexdigest())

    def test_initial_findings_are_gaps_not_a_complete_port_claim(self) -> None:
        findings = {finding["id"]: finding for finding in self.data["initialFindings"]}
        self.assertEqual(self.data["nativePortCoverage"], "incomplete")
        self.assertEqual(
            findings["persona-directive-400-character-projection"]["status"], "verified-gap"
        )
        self.assertEqual(findings["episode-five-turn-minimum"]["status"], "verified-gap")


if __name__ == "__main__":
    unittest.main()
