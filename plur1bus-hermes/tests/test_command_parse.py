import unittest

from plur1bus_controls.command_parse import parse_correction


class CommandParseTests(unittest.TestCase):
    def test_parses_documented_correction_separators(self):
        self.assertEqual(
            parse_correction(["Bernd", "ist", "in", "Bonn", "zu", "Bernd", "ist", "in", "Berlin"]),
            ("Bernd ist in Bonn", "Bernd ist in Berlin"),
        )
        self.assertEqual(
            parse_correction(["old", "->", "new"]),
            ("old", "new"),
        )


if __name__ == "__main__":
    unittest.main()
