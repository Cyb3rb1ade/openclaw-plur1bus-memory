"""E2E-Negativtests: bulk writers must not revive tombstoned text (7.4.0).

Covers the migration card copy and the workspace-migration staging path:
forgotten text bound to the target scope is skipped and honestly counted,
clean text passes, and foreign-scope tombstones neither block nor get ignored.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from plur1bus_hermes.migrate import _card_from_legacy, _copy_agent_cards
from plur1bus_hermes.tombstone import (
    append_tombstone_to_registry,
    build_tombstone,
    partition_cards_by_tombstone_guard,
)
from plur1bus_hermes.workspace_migrate import _stage_agents, _workspace_card

UUID_A = "a4563cc9-7611-4528-992a-075f8889a018"
UUID_B = "b4563cc9-7611-4528-992a-075f8889a019"


def _commit_workspace_tombstone(base: Path, agent: str, text: str, *, workspace: str = "default") -> None:
    tombstone = build_tombstone(
        card={"id": UUID_A, "content": text, "scope": "workspace", "workspaceKey": workspace},
        agent_id=agent,
    )
    append_tombstone_to_registry(base, agent, {**tombstone, "status": "committed"})


def _write_source_table(snapshot: Path, agent: str, rows: list[dict]) -> None:
    import lancedb

    source_dir = snapshot / "lancedb-namespaced" / agent
    source_dir.mkdir(parents=True, exist_ok=True)
    lancedb.connect(str(source_dir)).create_table("memories", data=rows)


def _read_target_contents(target: Path, agent: str) -> list[str]:
    import lancedb

    table = lancedb.connect(str(target / "lancedb" / agent)).open_table("memories")
    return sorted(str(row["content"]) for row in table.to_arrow().to_pylist())


class PartitionGuardTests(unittest.TestCase):
    def test_partition_binds_scope_and_agent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            _commit_workspace_tombstone(base, "agent-a", "vergessener Fakt")
            cards = [{"content": "vergessener Fakt"}, {"content": "sauberer Fakt"}]
            allowed, blocked = partition_cards_by_tombstone_guard(
                base, "agent-a", cards, scope="workspace", workspace_identity="default",
            )
            self.assertEqual([card["content"] for card in allowed], ["sauberer Fakt"])
            self.assertEqual([card["content"] for card in blocked], ["vergessener Fakt"])
            # Foreign agent is not blocked (scope/owner binding).
            allowed_other, _ = partition_cards_by_tombstone_guard(
                base, "agent-b", cards, scope="workspace", workspace_identity="default",
            )
            self.assertEqual(len(allowed_other), 2)
            # Foreign scope is not blocked either — exact scope-type binding.
            allowed_private, _ = partition_cards_by_tombstone_guard(
                base, "agent-a", cards, scope="agent-private",
            )
            self.assertEqual(len(allowed_private), 2)


class MigrationCopyGuardTests(unittest.TestCase):
    def test_copy_agent_cards_skips_tombstoned_text(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            snapshot = root / "snapshot"
            target = root / "target"
            target.mkdir(parents=True)
            _commit_workspace_tombstone(target, "main", "vergessener Fakt")
            _write_source_table(snapshot, "main", [
                {
                    "id": UUID_A, "content": "vergessener Fakt", "status": "active",
                    "type": "observation", "sessionId": "s1", "createdAt": "2026-01-01",
                    "vector": [0.1, 0.2],
                },
                {
                    "id": UUID_B, "content": "sauberer Fakt", "status": "active",
                    "type": "observation", "sessionId": "s1", "createdAt": "2026-01-01",
                    "vector": [0.3, 0.4],
                },
            ])

            result = _copy_agent_cards(snapshot, target, "main", "main")

            self.assertEqual(result["cardsCopied"], 1)
            self.assertEqual(result["cardsTombstoneBlocked"], 1)
            self.assertEqual(_read_target_contents(target, "main"), ["sauberer Fakt"])

    def test_copy_agent_cards_without_tombstones_copies_all(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            snapshot = root / "snapshot"
            target = root / "target"
            target.mkdir(parents=True)
            _write_source_table(snapshot, "main", [
                {
                    "id": UUID_B, "content": "sauberer Fakt", "status": "active",
                    "type": "observation", "sessionId": "s1", "createdAt": "2026-01-01",
                    "vector": [0.3, 0.4],
                },
            ])

            result = _copy_agent_cards(snapshot, target, "main", "main")

            self.assertEqual(result["cardsCopied"], 1)
            self.assertEqual(result["cardsTombstoneBlocked"], 0)


class EpistemicCarryoverTests(unittest.TestCase):
    def test_card_from_legacy_preserves_explicit_status_only(self) -> None:
        row = {
            "id": UUID_A, "content": "x", "vector": [0.1], "status": "active",
            "epistemicStatus": "corroborated",
        }
        card = _card_from_legacy(row, "main")
        self.assertEqual(card["epistemicStatus"], "corroborated")
        # Rows that never carried a status stay legacy — nothing is invented.
        row.pop("epistemicStatus")
        card = _card_from_legacy(row, "main")
        self.assertNotIn("epistemicStatus", card)

    def test_workspace_card_preserves_explicit_status_only(self) -> None:
        row = {
            "id": UUID_A, "content": "x", "status": "active",
            "epistemicStatus": "observed",
        }
        card = _workspace_card(row, "main", "main", [0.1])
        self.assertEqual(card["epistemicStatus"], "observed")
        row.pop("epistemicStatus")
        card = _workspace_card(row, "main", "main", [0.1])
        self.assertNotIn("epistemicStatus", card)


class WorkspaceStagingGuardTests(unittest.TestCase):
    def test_stage_agents_never_reembeds_tombstoned_text(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            snapshot = root / "snapshot"
            staging = root / "staging"
            target = root / "target"
            staging.mkdir(parents=True)
            target.mkdir(parents=True)
            # Production wiring: the registry lives at the live target root,
            # never in the fresh staging directory.
            _commit_workspace_tombstone(target, "main", "vergessener Fakt")
            _write_source_table(snapshot, "main", [
                {
                    "id": UUID_A, "content": "vergessener Fakt", "status": "active",
                    "type": "observation", "sessionId": "s1", "createdAt": "2026-01-01",
                    "vector": [0.1, 0.2],
                },
                {
                    "id": UUID_B, "content": "sauberer Fakt", "status": "active",
                    "type": "observation", "sessionId": "s1", "createdAt": "2026-01-01",
                    "vector": [0.3, 0.4],
                },
            ])
            config = {"embedding": {"provider": "local-transformers", "model": "fake"}}
            with patch("plur1bus_hermes.workspace_migrate.EmbeddingBackend") as backend:
                backend.return_value.embed_many = lambda texts: [[0.1, 0.2] for _ in texts]
                copied, _, _ = _stage_agents(
                    snapshot, staging, {"main": "main"}, config, 50,
                    tombstone_base=target,
                )

            self.assertEqual(copied[0]["cardsTombstoneBlocked"], 1)
            self.assertEqual(copied[0]["cardsReembedded"], 1)
            # The blocked text was never embedded or written.
            self.assertEqual(_read_target_contents(staging, "main"), ["sauberer Fakt"])

    def test_stage_agents_without_target_registry_is_a_noop_guard(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            snapshot = root / "snapshot"
            staging = root / "staging"
            target = root / "target"
            staging.mkdir(parents=True)
            target.mkdir(parents=True)
            _write_source_table(snapshot, "main", [
                {
                    "id": UUID_B, "content": "sauberer Fakt", "status": "active",
                    "type": "observation", "sessionId": "s1", "createdAt": "2026-01-01",
                    "vector": [0.3, 0.4],
                },
            ])
            config = {"embedding": {"provider": "local-transformers", "model": "fake"}}
            with patch("plur1bus_hermes.workspace_migrate.EmbeddingBackend") as backend:
                backend.return_value.embed_many = lambda texts: [[0.1, 0.2] for _ in texts]
                copied, _, _ = _stage_agents(
                    snapshot, staging, {"main": "main"}, config, 50,
                    tombstone_base=target,
                )

            self.assertEqual(copied[0]["cardsTombstoneBlocked"], 0)
            self.assertEqual(_read_target_contents(staging, "main"), ["sauberer Fakt"])


class WorkspaceApplyPreservesRegistriesTests(unittest.TestCase):
    """The staged switch must carry tombstones and the epistemic cutoff forward."""

    def test_apply_preserves_sibling_registries_and_blocks_revival(self) -> None:
        import argparse

        from plur1bus_hermes.workspace_migrate import run_migrate

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            snapshot = root / "snapshot"
            target = root / "target"
            (source / "lancedb-namespaced" / "main").mkdir(parents=True)
            target.mkdir(parents=True)
            _commit_workspace_tombstone(target, "main", "vergessener Fakt")
            marker_dir = target / "_epistemic"
            marker_dir.mkdir(parents=True)
            (marker_dir / "explicit-write-since.json").write_text(
                '{"since": 1700000000000, "createdAt": 1700000000000}\n', encoding="utf-8",
            )
            (marker_dir / "EXPLICIT_WRITES_ENABLED").write_text("1\n", encoding="utf-8")
            _write_source_table(snapshot, "main", [
                {
                    "id": UUID_A, "content": "vergessener Fakt", "status": "active",
                    "type": "observation", "sessionId": "s1", "createdAt": "2026-01-01",
                    "vector": [0.1, 0.2],
                },
                {
                    "id": UUID_B, "content": "sauberer Fakt", "status": "active",
                    "type": "observation", "sessionId": "s1", "createdAt": "2026-01-01",
                    "vector": [0.3, 0.4],
                },
            ])
            args = argparse.Namespace(
                source=str(source),
                target=str(target),
                snapshot=str(snapshot),
                config={"embedding": {"provider": "local-transformers", "model": "fake", "dimensions": 2}},
                agent_map={},
                auto_map=True,
                replace_target=True,
                apply=True,
                report="",
                batch_size=50,
                resume_staging="",
                log_file="",
                workspace_map={},
            )
            agents = ([{"agentId": "main", "path": str(source / "lancedb-namespaced" / "main"), "hasData": True}], [])
            with patch("plur1bus_hermes.workspace_migrate._migratable_agents", return_value=agents), \
                 patch("plur1bus_hermes.workspace_migrate.EmbeddingBackend") as backend:
                backend.return_value.embed_many = lambda texts: [[0.1, 0.2] for _ in texts]
                report = run_migrate(args)

            self.assertEqual(report["status"], "completed", report.get("errors"))
            self.assertEqual(report["reembeddedAgents"][0]["cardsTombstoneBlocked"], 1)
            # The tombstoned text was never revived in the activated store.
            self.assertEqual(_read_target_contents(target, "main"), ["sauberer Fakt"])
            # Both sibling registries survived the staged switch.
            self.assertTrue((target / "_tombstones" / "main.jsonl").is_file())
            self.assertTrue((target / "_epistemic" / "explicit-write-since.json").is_file())
            self.assertTrue((target / "_epistemic" / "EXPLICIT_WRITES_ENABLED").is_file())
            # The replaced target keeps its own copy in the timestamped backup.
            backup = Path(report["replacedTargetBackup"])
            self.assertTrue((backup / "_tombstones" / "main.jsonl").is_file())


if __name__ == "__main__":
    unittest.main()
