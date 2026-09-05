import tempfile
import unittest
from pathlib import Path

from plur1bus_hermes.rate_gate import JobRateGate


class RateGateTests(unittest.TestCase):
    def test_persists_interval_and_does_not_mark_failed_operation(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "gate.json"
            gate = JobRateGate(path)
            calls = []

            first = gate.run("dream", 100, lambda: calls.append(1) or {"ok": True}, now=1000)
            second = JobRateGate(path).run(
                "dream", 100, lambda: calls.append(2), now=1050
            )

            self.assertTrue(first["ok"])
            self.assertTrue(second["skipped"])
            self.assertEqual(calls, [1])


if __name__ == "__main__":
    unittest.main()
