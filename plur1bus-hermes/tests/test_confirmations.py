import unittest
from types import SimpleNamespace

from plur1bus_controls.confirmations import ConfirmationStore


class ConfirmationTests(unittest.TestCase):
    def test_nonce_is_one_time_command_user_chat_and_expiry_bound(self):
        store = ConfirmationStore(ttl_seconds=60)
        owner = SimpleNamespace(user_id="owner", chat_id="private")
        other = SimpleNamespace(user_id="other", chat_id="private")
        nonce = store.issue("forget", ["memory"], owner, now=100)

        self.assertFalse(
            store.consume(nonce, "forget", ["memory"], other, now=110)
        )
        nonce = store.issue("forget", ["memory"], owner, now=100)
        self.assertFalse(
            store.consume(nonce, "forget", ["different"], owner, now=110)
        )
        nonce = store.issue("forget", ["memory"], owner, now=100)
        self.assertTrue(
            store.consume(nonce, "forget", ["memory"], owner, now=110)
        )
        self.assertFalse(
            store.consume(nonce, "forget", ["memory"], owner, now=111)
        )


if __name__ == "__main__":
    unittest.main()
