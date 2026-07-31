import json
import tempfile
import unittest
from pathlib import Path

from plur1bus_hermes.feature_profiles import apply_profile, set_feature


class FeatureProfileTests(unittest.TestCase):
    def test_recommended_preserves_authored_opt_out_and_safety_gates(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.json"
            path.write_text(
                json.dumps({"criticalPush": {"enabled": False}}),
                encoding="utf-8",
            )

            config = apply_profile(path, "recommended")

            self.assertFalse(config["criticalPush"]["enabled"])
            self.assertTrue(config["dailyConsolidation"]["enabled"])
            self.assertFalse(config["merging"]["autoApply"])
            self.assertEqual(config["obsidianBridge"]["mode"], "augment")
            self.assertTrue(list(path.parent.glob("config.json.bak.*")))

    def test_toggle_allowlist_rejects_unknown_feature(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.json"
            with self.assertRaises(ValueError):
                set_feature(path, "unknown", True)


if __name__ == "__main__":
    unittest.main()
