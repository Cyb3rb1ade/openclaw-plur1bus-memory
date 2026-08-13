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

    def test_review_by_short_reference_accepts_pending(self):
        with tempfile.TemporaryDirectory() as temporary:
            domain = Plur1busDomain(Path(temporary), "main")
            domain._append_jsonl(
                domain.state_dir / "critical-push.jsonl",
                {
                    "id": "a4563cc9-7611-4528-992a-075f8889a018",
                    "status": "pending_review",
                    "createdAt": "2026-07-01T00:00:00+00:00",
                },
            )

            self.assertEqual(
                domain.critical_reference_map()["a4563cc9-7611-4528-992a-075f8889a018"],
                "9a018",
            )
            result = domain.review_critical_by_reference("9a018", "reject")

            self.assertTrue(result["updated"])
            self.assertEqual(result["status"], "rejected")
            self.assertEqual(domain.critical_items("pending_review"), [])

    def test_review_by_unknown_reference_changes_nothing(self):
        with tempfile.TemporaryDirectory() as temporary:
            domain = Plur1busDomain(Path(temporary), "main")
            domain._append_jsonl(
                domain.state_dir / "critical-push.jsonl",
                {
                    "id": "a4563cc9-7611-4528-992a-075f8889a018",
                    "status": "pending_review",
                    "createdAt": "2026-07-01T00:00:00+00:00",
                },
            )

            result = domain.review_critical_by_reference("fffff", "accept")

            self.assertFalse(result["updated"])
            self.assertEqual(result["reason"], "not_found")
            self.assertEqual(len(domain.critical_items("pending_review")), 1)


if __name__ == "__main__":
    unittest.main()
