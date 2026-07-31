"""Regression coverage for functional `/plur1bus` command dispatch."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import lancedb

from plur1bus_controls.plugin import Plur1busControlsPlugin


class ControlsTests(unittest.TestCase):
    def test_status_and_doctor_use_real_domain_store(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            plugin_dir = home / "plugins" / "plur1bus"
            plugin_dir.mkdir(parents=True)
            (plugin_dir / "config.json").write_text(json.dumps({
                "dataDir": "data",
                "agentId": "main",
                "embedding": {"provider": "omlx", "model": "embed", "dimensions": 4},
                "reranker": {"provider": "disabled"},
            }), encoding="utf-8")
            agent_dir = home / "data" / "lancedb" / "main"
            agent_dir.mkdir(parents=True)
            lancedb.connect(str(agent_dir)).create_table("memories", data=[{
                "id": "619c3d51-1d9d-4736-8bf9-91b38aff8246",
                "agentId": "main",
                "scopeKey": "scope",
                "sessionId": "session",
                "content": "Memory",
                "status": "active",
                "type": "observation",
                "sourceRole": "user",
                "createdAt": "now",
                "vector": [1.0, 0.0, 0.0, 0.0],
            }])
            plugin = Plur1busControlsPlugin({"hermesHome": str(home), "agentId": "main"})

            status = json.loads(plugin.handle_command("status"))
            doctor = json.loads(plugin.handle_command("doctor"))
            self.assertEqual(status["status"], "ready")
            self.assertEqual(doctor["memoryRows"], 1)


if __name__ == "__main__":
    unittest.main()
