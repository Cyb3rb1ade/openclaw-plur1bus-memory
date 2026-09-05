import unittest

from plur1bus_hermes.cognition import analyze_text_tiered


class EmotionTierTests(unittest.TestCase):
    def test_t3_result_is_used_and_unavailable_t3_falls_back_to_t1(self):
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
        self.assertEqual(fallback["emotion"]["tierUsed"], "t1")
        self.assertEqual(
            fallback["emotion"]["fallback"],
            "t3-unavailable-to-t1",
        )

    def test_t2_requires_a_real_classifier_and_accepts_dependency_injection(self):
        configured = {"emotion": {"tier": "t2", "t2": {"enabled": True}}}
        unavailable = analyze_text_tiered("ambiguous", configured)
        self.assertEqual(unavailable["emotion"]["tierUsed"], "t1")
        self.assertEqual(unavailable["emotion"]["fallback"], "t2-not-configured-to-t1")

        classified = analyze_text_tiered(
            "ambiguous",
            configured,
            t2_classifier=lambda _text: {
                "dominant": "trust", "intensity": 0.8, "valence": "positive",
            },
        )
        self.assertEqual(classified["emotion"]["tierUsed"], "t2")
        self.assertEqual(classified["emotion"]["dominant"], "trust")


if __name__ == "__main__":
    unittest.main()
