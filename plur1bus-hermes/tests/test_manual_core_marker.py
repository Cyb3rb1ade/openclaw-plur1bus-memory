"""Hermes parity for the 7.3.4 manual importance core marker."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from plur1bus_hermes.domain import Plur1busDomain


class ManualCoreMarkerTests(unittest.TestCase):
    def test_exact_importance_one_is_durable_core_without_emotion(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            domain = Plur1busDomain(Path(directory), "main")
            metadata = domain._metadata_for(
                {
                    "content": "Ruhige Sicherheitsnotiz ohne emotionale Signalwörter.",
                    "sourceRole": "user",
                },
                importance=1.0,
            )

        self.assertEqual(metadata["importance"], 1.0)
        self.assertTrue(metadata["neverForget"])
        self.assertEqual(metadata["memoryClass"], "core")
        self.assertEqual(metadata["coreMemoryScore"], 1.0)
        self.assertEqual(metadata["coreMemoryReason"], "manual_importance_marker")
        self.assertEqual(metadata["halfLifeDays"], 36500)

    def test_values_below_one_remain_standard(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            domain = Plur1busDomain(Path(directory), "main")
            metadata = domain._metadata_for(
                {"content": "Normale Notiz.", "sourceRole": "user"},
                importance=0.99,
            )

        self.assertFalse(metadata["neverForget"])
        self.assertEqual(metadata["memoryClass"], "standard")
        self.assertEqual(metadata["coreMemoryScore"], 0.0)


if __name__ == "__main__":
    unittest.main()
