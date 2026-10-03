"""Process health counters stay bounded, scoped, and secret-free."""

from __future__ import annotations

import unittest
import time
from types import SimpleNamespace

from plur1bus_hermes.health_watch import owner_key, record_failure, snapshot
from plur1bus_hermes.llm_backend import InternalLlmBackend
from plur1bus_hermes.operator_status import read_operator_status


class HealthWatchTests(unittest.TestCase):
    def test_actual_llm_backend_failures_feed_owner_registry(self):
        scope = "scope-health-test-backend"
        backend = InternalLlmBackend(
            {"llm": {"model": "test", "baseUrl": "https://private.invalid/v1"}},
            "agent", opener=lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("secret-path")),
            scope_key=scope,
        )
        for _ in range(3):
            with self.assertRaises(RuntimeError):
                backend.complete_json("episode-extraction", "private prompt", "private content")
        rows = snapshot(owner_key("agent", scope))
        self.assertEqual(rows[0]["count"], 3)
        self.assertEqual(rows[0]["feature"], "episode-extraction")
        self.assertNotIn("secret-path", repr(rows))
        self.assertNotIn("private prompt", repr(rows))
        self.assertNotIn("private.invalid", repr(rows))

    def test_window_grouping_and_owner_isolation(self):
        owner = owner_key("agent", "scope-health-test-a")
        other = owner_key("agent", "scope-health-test-b")
        for at in (100, 101, 102):
            record_failure(owner, agent_id="agent", feature="episode-extraction", hint="network",
                           error_class="URLError", at=at)
        record_failure(other, agent_id="agent", feature="episode-extraction", hint="network",
                       error_class="URLError", at=102)
        self.assertEqual(snapshot(owner, now=102)[0]["count"], 3)
        self.assertEqual(snapshot(other, now=102)[0]["count"], 1)
        self.assertEqual(snapshot(owner, now=102 + 24 * 60 * 60 + 1), [])

    def test_timeout_does_not_degrade_and_authority_expiry_is_fixed_category(self):
        owner = owner_key("agent", "scope-health-test-timeout")
        for at in (1, 2, 3):
            record_failure(owner, agent_id="agent", feature="dream-narrative", hint="timeout", at=at)
        class PrivateFailure(RuntimeError):
            pass
        error = PrivateFailure("caller authority is no longer active; token=DO_NOT_EXPORT")
        record_failure(owner, agent_id="agent", feature="dream-narrative", hint="other",
                       error=error, error_class="PrivateFailure", at=4)
        rows = snapshot(owner, now=4)
        timeout_row = next(row for row in rows if row["hint"] == "timeout")
        authority_row = next(row for row in rows if row["hint"] == "authority-expired")
        self.assertEqual(timeout_row["count"], 3)
        self.assertNotIn("DO_NOT_EXPORT", repr(rows))
        self.assertEqual(authority_row["errorClass"], "PrivateFailure")

    def test_operator_projection_is_scoped_and_gateway_mapping_is_not_assumed(self):
        owner = owner_key("agent", "scope-health-test-view")
        now = time.time()
        for at in range(3):
            record_failure(owner, agent_id="agent", feature="episode-extraction", hint="network", at=now + at)
        runtime = SimpleNamespace(agent_id="agent", scope_binding=SimpleNamespace(scope_key="scope-health-test-view"),
                                  config={}, profile="agent")
        result = read_operator_status(runtime, connect=lambda _path: (_ for _ in ()).throw(OSError("private path")))
        health = result["health"]
        self.assertEqual(health["llm"]["state"], "degraded")
        self.assertEqual(health["llm"]["failures"][0]["count"], 3)
        self.assertEqual(health["gateway"]["state"], "unavailable")
        self.assertEqual(health["gateway"]["code"], "hermes_signal_mapping_unsupported")
        self.assertNotIn("private path", repr(result))
        self.assertNotIn("scope-health-test-view", repr(result))


if __name__ == "__main__":
    unittest.main()
