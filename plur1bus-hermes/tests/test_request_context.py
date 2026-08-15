import unittest
from types import SimpleNamespace

from plur1bus_controls.request_context import (
    RequestIdentity,
    capture_gateway_identity,
    is_mutation_authorized,
)


class RequestContextTests(unittest.TestCase):
    def test_gateway_context_preserves_canonical_workspace_user_and_chat_fields(self):
        identity = capture_gateway_identity(SimpleNamespace(
            source=SimpleNamespace(
                platform=SimpleNamespace(value="signal"),
                userId="user-7",
                chatId="chat-9",
                workspaceIdentity="workspace-3",
                scopeType="chat",
                profile="agent",
            )
        ))

        self.assertEqual(identity.as_scope(), {
            "scopeType": "chat",
            "workspace": "workspace-3",
            "platform": "signal",
            "user": "user-7",
            "chat": "chat-9",
            "account": "",
        })

    def test_identity_can_be_passed_as_canonical_scope_context(self):
        identity = RequestIdentity(
            platform="telegram",
            user_id="owner",
            chat_id="chat",
            chat_type="group",
            profile="bernd",
            role_authorized=True,
            workspace_id="workspace",
            scope_type="chat",
        )

        self.assertEqual(identity.as_scope(), {
            "scopeType": "chat",
            "workspace": "workspace",
            "platform": "telegram",
            "user": "owner",
            "chat": "chat",
            "account": "",
        })

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
