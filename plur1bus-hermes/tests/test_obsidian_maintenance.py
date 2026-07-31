import tempfile
import unittest
from pathlib import Path

from plur1bus_hermes.obsidian_maintenance import generate_obsidian_control_room


class ObsidianMaintenanceTests(unittest.TestCase):
    def test_generates_managed_control_room_without_user_note_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            result = generate_obsidian_control_room(
                workspace,
                "main",
                metadata_rows=[
                    {
                        "metadataJson": (
                            '{"status":"active","category":"identity"}'
                        )
                    }
                ],
                episodes=[{"id": "episode"}],
                dreams=[{"narrative": "A useful association"}],
                contradictions=[
                    {
                        "newMemoryId": "new",
                        "existingMemoryId": "old",
                        "score": 0.9,
                    }
                ],
                open_threads=[
                    {"text": "Finish migration", "status": "open"}
                ],
            )

            self.assertTrue(result["managedOnly"])
            control = workspace / ".plur1bus/control-room"
            self.assertTrue((control / "Dashboard.md").is_file())
            self.assertTrue((control / "Memories.base").is_file())
            self.assertIn(
                "Finish migration",
                (control / "Open Threads.md").read_text(encoding="utf-8"),
            )


if __name__ == "__main__":
    unittest.main()
