import unittest
from types import SimpleNamespace

from plur1bus_controls.request_context import (
    capture_gateway_identity,
    is_mutation_authorized,
)


class RequestContextTests(unittest.TestCase):
    def test_private_chat_owner_is_allowed_without_whitelist(self):
        event = SimpleNamespace(
            source=SimpleNamespace(
                platform=SimpleNamespace(value="telegram"),
                user_id="owner",
                chat_id="chat",
                chat_type="dm",
                profile="bernd",
                role_authorized=False,
            )
        )

        identity = capture_gateway_identity(event)

        self.assertTrue(is_mutation_authorized({}, identity))
        self.assertEqual(identity.profile, "bernd")

    def test_group_is_denied_and_user_allowlist_never_accepts_chat_only(self):
        group = SimpleNamespace(
            source=SimpleNamespace(
                platform=SimpleNamespace(value="telegram"),
                user_id="other",
                chat_id="allowed-chat",
                chat_type="group",
                profile=None,
                role_authorized=True,
            )
        )
        identity = capture_gateway_identity(group)

        self.assertFalse(is_mutation_authorized({}, identity))
        self.assertFalse(
            is_mutation_authorized(
                {
                    "controls": {
                        "allowedUserIds": ["owner"],
                        "allowedChatIds": ["allowed-chat"],
                    }
                },
                identity,
            )
        )


if __name__ == "__main__":
    unittest.main()
