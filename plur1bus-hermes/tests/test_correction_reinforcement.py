import tempfile
import unittest
from pathlib import Path

from plur1bus_hermes.domain import Plur1busDomain


class CorrectionReinforcementTests(unittest.TestCase):
    def test_correction_metadata_is_immediately_reinforced(self):
        with tempfile.TemporaryDirectory() as temporary:
            domain = Plur1busDomain(Path(temporary), "main")

            metadata = domain._metadata_for(
                {
                    "content": "Corrected fact",
                    "sourceRole": "correction",
                    "status": "active",
                }
            )

            self.assertEqual(metadata["retrievalCount"], 1)
            self.assertGreater(metadata["lastRetrievedAt"], 0)
            self.assertGreater(metadata["memoryStrength"], 1.0)


if __name__ == "__main__":
    unittest.main()
