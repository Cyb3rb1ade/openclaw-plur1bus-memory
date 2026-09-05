import json
import unittest

from plur1bus_controls.plugin import Plur1busControlsPlugin


class _Domain:
    pass


class _Runtime:
    def __init__(self, allowed):
        self.config = {"controls": {"allowMutatingCommands": allowed}}
        self._domain = _Domain()
        self.forgotten = []

    def _table(self, create=False):
        return None, None

    def forget(self, memory_id):
        self.forgotten.append(memory_id)
        return True

    def resolve_memory_id(self, reference):
        return reference


class ControlsSecurityTests(unittest.TestCase):
    def test_mutations_are_denied_without_explicit_trusted_instance_opt_in(self):
        plugin = Plur1busControlsPlugin()
        runtime = _Runtime(False)
        plugin._runtime = lambda _agent: runtime

        result = json.loads(plugin.handle_command("forget memory-id"))

        self.assertEqual(result["status"], "denied")
        self.assertEqual(runtime.forgotten, [])

    def test_explicit_trusted_instance_opt_in_allows_mutation(self):
        plugin = Plur1busControlsPlugin()
        runtime = _Runtime(True)
        plugin._runtime = lambda _agent: runtime

        result = json.loads(plugin.handle_command("forget memory-id"))

        self.assertTrue(result["archived"])
        self.assertEqual(runtime.forgotten, ["memory-id"])

    def test_merge_repair_is_denied_without_mutation_authorization(self):
        plugin = Plur1busControlsPlugin()
        runtime = _Runtime(False)
        runtime.repair_calls = []
        runtime.repair_merge_proposal = lambda proposal_id, *, approved_revision: runtime.repair_calls.append((proposal_id, approved_revision)) or True
        plugin._runtime = lambda _agent: runtime

        result = json.loads(plugin.handle_command(
            "merge repair 11111111-1111-4111-8111-111111111111 " + "d" * 64
        ))

        self.assertEqual(result["status"], "denied")
        self.assertEqual(runtime.repair_calls, [])


if __name__ == "__main__":
    unittest.main()
