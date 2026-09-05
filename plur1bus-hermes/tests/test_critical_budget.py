import tempfile
import unittest
from pathlib import Path

from plur1bus_hermes.domain import Plur1busDomain


class _Table:
    def search(self, _vector):
        raise RuntimeError("neighbor search unavailable in isolated test")


class CriticalBudgetTests(unittest.TestCase):
    def test_classifies_once_and_suppresses_push_over_daily_budget(self):
        with tempfile.TemporaryDirectory() as temporary:
            domain = Plur1busDomain(
                Path(temporary),
                "main",
                {"criticalPush": {"maxPerDay": 0}},
            )
            record = {
                "id": "53628ada-8595-43dc-92da-216fe2c69836",
                "content": "Never forget this critical fact",
                "sourceRole": "user",
                "status": "active",
                "type": "observation",
                "vector": [0.1, 0.2],
            }

            domain.on_memory(record, _Table())
            domain.on_memory(record, _Table())

            classifications = domain._read_jsonl(
                domain.state_dir / "critical-classification.jsonl"
            )
            pushes = domain._read_jsonl(
                domain.state_dir / "critical-push.jsonl"
            )
            self.assertEqual(len(classifications), 1)
            self.assertEqual(pushes[-1]["status"], "budget_suppressed")


if __name__ == "__main__":
    unittest.main()
