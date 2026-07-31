import tempfile
import unittest
from pathlib import Path

from plur1bus_hermes.domain import Plur1busDomain


class CriticalWorkflowTests(unittest.TestCase):
    def test_pending_critical_can_be_accepted_append_only(self):
        with tempfile.TemporaryDirectory() as temporary:
            domain = Plur1busDomain(Path(temporary), "main")
            domain._append_jsonl(
                domain.state_dir / "critical-push.jsonl",
                {
                    "id": "53628ada-8595-43dc-92da-216fe2c69836",
                    "status": "pending_review",
                    "createdAt": "2026-07-01T00:00:00+00:00",
                },
            )

            result = domain.review_critical(
                "53628ada-8595-43dc-92da-216fe2c69836",
                "accept",
            )

            self.assertTrue(result["updated"])
            self.assertEqual(result["status"], "accepted")
            self.assertEqual(domain.critical_items(), [])
            self.assertEqual(len(domain.critical_items(None)), 1)


if __name__ == "__main__":
    unittest.main()
