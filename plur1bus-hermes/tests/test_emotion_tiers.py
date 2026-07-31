import unittest

from plur1bus_hermes.cognition import analyze_text_tiered


class EmotionTierTests(unittest.TestCase):
    def test_t3_result_is_used_and_unavailable_t3_falls_back_to_t2(self):
        configured = {"emotion": {"tier": "t3"}}
        used = analyze_text_tiered(
            "A complex feeling",
            configured,
            complete_json=lambda *_args: {
                "dominant": "trust",
                "intensity": 0.7,
                "valence": "positive",
            },
        )
        fallback = analyze_text_tiered("A feeling", configured)

        self.assertEqual(used["emotion"]["tierUsed"], "t3")
        self.assertEqual(used["emotion"]["dominant"], "trust")
        self.assertEqual(fallback["emotion"]["tierUsed"], "t2")
        self.assertEqual(
            fallback["emotion"]["fallback"],
            "t3-unavailable-to-t2",
        )


if __name__ == "__main__":
    unittest.main()
