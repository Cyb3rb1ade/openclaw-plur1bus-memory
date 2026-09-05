import unittest

from plur1bus_hermes.critical_reply_intent import (
    build_critical_reply_command,
    extract_critical_refs,
    looks_like_critical_push,
    parse_critical_reply_intent,
)


PUSH = """🧠 PLUR1BUS hat eine Erinnerung als möglicherweise besonders wichtig erkannt.
Referenz: a0011
Referenz: b0022
"""


class CriticalReplyIntentTests(unittest.TestCase):
    def test_only_real_push_headline_allows_reference_extraction_to_act(self):
        self.assertTrue(looks_like_critical_push(PUSH))
        self.assertEqual(extract_critical_refs(PUSH), ["a0011", "b0022"])
        self.assertIsNone(build_critical_reply_command(body="alle akzeptieren", reply_to_body="Referenz: a0011"))

    def test_ambiguous_multi_reference_intent_does_not_act(self):
        self.assertIsNone(build_critical_reply_command(body="akzeptieren", reply_to_body=PUSH))
        self.assertIsNone(parse_critical_reply_intent("nicht akzeptieren"))

    def test_all_decision_builds_only_explicit_batch(self):
        command = build_critical_reply_command(body="Bitte alle ablehnen", reply_to_body=PUSH)
        self.assertEqual(command["action"], "reject")
        self.assertEqual(command["refs"], ["a0011", "b0022"])


if __name__ == "__main__":
    unittest.main()
