import unittest

from plur1bus_hermes.parity import parity_report


class ParityTests(unittest.TestCase):
    def test_report_does_not_hide_required_gaps_or_include_skill_farming(self):
        report = parity_report()
        by_id = {feature["id"]: feature for feature in report["features"]}

        self.assertEqual(report["status"], "partial")
        self.assertEqual(report["legacyInventoryStatus"], "incomplete")
        self.assertEqual(by_id["skill-farming"]["status"], "excluded")
        self.assertEqual(by_id["proactive-delivery"]["status"], "partial")
        # A completed legacy inventory must never become the public v7.10
        # readiness signal while the separate coverage gate is partial.
        self.assertNotEqual(report["status"], report["legacyInventoryStatus"])
        self.assertLess(report["readyRequired"], report["totalRequired"])
        self.assertEqual(report["coverageStatus"], "partial")
        coverage = {item["id"]: item for item in report["coverage710"]}
        self.assertEqual(coverage["skill-workshop"]["status"], "not-ported")


if __name__ == "__main__":
    unittest.main()
