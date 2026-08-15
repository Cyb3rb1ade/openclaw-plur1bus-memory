from __future__ import annotations

import unittest
from types import SimpleNamespace

from plur1bus_controls.plugin import Plur1busControlsPlugin
from plur1bus_controls.request_context import capture_gateway_identity


class ScopeControlsTests(unittest.TestCase):
    def test_request_identity_contains_workspace_and_canonical_scope_inputs(self):
        identity = capture_gateway_identity(SimpleNamespace(source=SimpleNamespace(
            platform=SimpleNamespace(value="telegram"),
            user_id="owner",
            chat_id="chat",
            chat_type="dm",
            workspace_id="workspace-a",
            scope_type="user",
            profile="agent",
        )))

        self.assertEqual(identity.workspace_id, "workspace-a")
        self.assertEqual(identity.scope_type, "user")
        self.assertEqual(identity.as_scope()["platform"], "telegram")

    def test_user_share_without_platform_or_user_binding_is_denied(self):
        capture_gateway_identity(None)
        plugin = Plur1busControlsPlugin({"allowMutatingCommands": True})

        result = plugin.handle_command("share --user 53628ada-8595-43dc-92da-216fe2c69836")

        self.assertIn("denied", result)


if __name__ == "__main__":
    unittest.main()
