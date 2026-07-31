import unittest

from plur1bus_hermes.semantic_input import prepare_semantic_input


class SemanticInputTests(unittest.TestCase):
    def test_long_input_is_bounded_and_deduplicated(self):
        text = ("A repeated sentence. " * 500) + ("A distinct fact. " * 500)

        result = prepare_semantic_input(text)

        self.assertTrue(result["compressed"])
        self.assertFalse(result["requiresSource"])
        self.assertLessEqual(len(result["text"]), 6000)
        self.assertEqual(result["text"].count("A repeated sentence."), 1)

    def test_over_100k_requires_workspace_or_vault_source(self):
        result = prepare_semantic_input("x" * 100_001)

        self.assertTrue(result["requiresSource"])
        self.assertIn("source file", result["message"])


if __name__ == "__main__":
    unittest.main()
