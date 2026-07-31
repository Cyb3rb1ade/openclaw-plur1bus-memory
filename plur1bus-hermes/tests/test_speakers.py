import tempfile
import unittest
from pathlib import Path

from plur1bus_hermes.speakers import SpeakerMappingStore


class SpeakerMappingTests(unittest.TestCase):
    def test_mapping_persists_and_resolves_labeled_segments(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "speakers.json"
            store = SpeakerMappingStore(path)
            store.set_mapping("B", "Bernd")

            reopened = SpeakerMappingStore(path)
            segments = reopened.segment("B: Wir machen weiter.\nUnknown: Hallo")

            self.assertEqual(reopened.mappings(), {"b": "Bernd"})
            self.assertEqual(segments[0]["speakerId"], "Bernd")
            self.assertTrue(segments[0]["mapped"])
            self.assertFalse(segments[1]["mapped"])


if __name__ == "__main__":
    unittest.main()
