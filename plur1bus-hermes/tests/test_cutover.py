"""Regression coverage for gated Hermes profile cutover planning."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from plur1bus_hermes.cutover import (
    _configure_profile_llm,
    _ensure_hermes_identity,
    _sanitize_hermes_context_files,
    build_plan,
)


class CutoverTests(unittest.TestCase):
    def test_context_files_remove_hermes_blocked_unicode(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            profile_home = Path(directory)
            (profile_home / "AGENTS.md").write_text(
                "Visible emoji sequence: person\u200dcomputer\n",
                encoding="utf-8",
            )

            result = _sanitize_hermes_context_files(profile_home)

            self.assertEqual(
                result["removedInvisibleCharacters"],
                {"AGENTS.md": 1},
            )
            self.assertEqual(
                (profile_home / "AGENTS.md").read_text(encoding="utf-8"),
                "Visible emoji sequence: personcomputer\n",
            )

    def test_openclaw_identity_is_prepended_to_hermes_soul_idempotently(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            profile_home = Path(directory)
            (profile_home / "IDENTITY.md").write_text(
                "# IDENTITY\n\nI am Bernd, the agent.\n",
                encoding="utf-8",
            )
            (profile_home / "USER.md").write_text(
                "# USER\n\nThe human is Christian.\n",
                encoding="utf-8",
            )
            (profile_home / "SOUL.md").write_text(
                "# SOUL\n\nBe direct.\n",
                encoding="utf-8",
            )

            first = _ensure_hermes_identity(profile_home)
            first_soul = (profile_home / "SOUL.md").read_text(encoding="utf-8")
            second = _ensure_hermes_identity(profile_home)
            second_soul = (profile_home / "SOUL.md").read_text(encoding="utf-8")

            self.assertTrue(first["configured"])
            self.assertTrue(second["configured"])
            self.assertEqual(first_soul, second_soul)
            self.assertTrue(first_soul.startswith("<!-- PLUR1BUS-HERMES-IDENTITY:BEGIN -->"))
            self.assertIn("I am Bernd, the agent.", first_soul)
            self.assertIn("USER.md describes the human", first_soul)
            self.assertIn("# SOUL\n\nBe direct.", first_soul)

    @patch("plur1bus_hermes.cutover._run")
    def test_omlx_llm_uses_registered_provider(self, run) -> None:
        with tempfile.TemporaryDirectory() as directory:
            profile_home = Path(directory)

            result = _configure_profile_llm(
                profile_home,
                {
                    "llm": {
                        "model": "local-model",
                        "baseUrl": "http://127.0.0.1:8000/v1",
                    }
                },
            )

            self.assertEqual(result["provider"], "omlx")
            self.assertEqual(
                [call.args[0] for call in run.call_args_list],
                [
                    ["hermes", "config", "set", "model.provider", "omlx"],
                    ["hermes", "config", "set", "model.default", "local-model"],
                    [
                        "hermes",
                        "config",
                        "set",
                        "model.base_url",
                        "http://127.0.0.1:8000/v1",
                    ],
                    [
                        "hermes",
                        "config",
                        "set",
                        "model.api_mode",
                        "chat_completions",
                    ],
                ],
            )
            self.assertIn("OMLX_API_KEY=local", (profile_home / ".env").read_text())

    def test_completed_manifest_maps_main_to_bernd_profile(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "target"
            hermes_home = root / "hermes"
            (target / "manifests").mkdir(parents=True)
            (target / "profiles" / "main").mkdir(parents=True)
            (target / "manifests" / "workspace-migration.json").write_text(
                json.dumps({"status": "completed"}),
                encoding="utf-8",
            )
            (target / "profiles" / "main" / "profile.json").write_text(
                json.dumps({"id": "main", "displayName": "Bernd"}),
                encoding="utf-8",
            )

            plan = build_plan(target, hermes_home)

            self.assertEqual(plan["status"], "blocked")
            self.assertEqual(plan["profiles"][0]["profileName"], "bernd")
            self.assertEqual(plan["profiles"][0]["internalAgentId"], "main")

    def test_missing_completed_manifest_blocks_cutover(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            plan = build_plan(root / "target", root / "hermes")
            self.assertEqual(plan["status"], "blocked")

    @patch("plur1bus_hermes.cutover.parity_report")
    def test_incomplete_feature_parity_blocks_cutover(self, report) -> None:
        report.return_value = {
            "status": "incomplete",
            "readyRequired": 45,
            "totalRequired": 46,
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "target"
            (target / "manifests").mkdir(parents=True)
            (target / "profiles" / "main").mkdir(parents=True)
            (target / "manifests" / "workspace-migration.json").write_text(
                json.dumps({"status": "completed"}),
                encoding="utf-8",
            )
            (target / "profiles" / "main" / "profile.json").write_text(
                json.dumps({"id": "main"}),
                encoding="utf-8",
            )

            plan = build_plan(target, root / "hermes")

            self.assertEqual(plan["status"], "blocked")
            self.assertIn("feature parity is incomplete", plan["errors"][-1])


if __name__ == "__main__":
    unittest.main()
