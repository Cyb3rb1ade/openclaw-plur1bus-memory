"""Gateway cache invalidation for PLUR1BUS routing identity changes."""

import json

from plur1bus_hermes.provider import Plur1busMemoryProvider


def _write(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


def test_identity_signature_changes_for_root_and_profile_aliases_but_not_secrets(tmp_path):
    provider = Plur1busMemoryProvider()
    provider._hermes_home = tmp_path
    root = tmp_path / "plugins" / "plur1bus" / "config.json"
    profile = tmp_path / "profiles" / "Coder" / "plugins" / "plur1bus" / "config.json"
    _write(root, {"agentId": "default", "agentAliases": {"Coder": "writer"},
                  "embedding": {"apiKey": "secret-one", "endpoint": "https://one.invalid"}})
    _write(profile, {"agentId": "coder", "agentAliases": {"coder": "writer"}})

    first = provider.identity_signature()
    _write(root, {"agentId": "default", "agentAliases": {"Coder": "writer"},
                  "embedding": {"apiKey": "secret-two", "endpoint": "https://two.invalid"}})
    assert provider.identity_signature() == first

    _write(profile, {"agentId": "coder", "agentAliases": {"coder": "researcher"}})
    assert provider.identity_signature() != first

    _write(root, {"agentId": "changed-default", "agentAliases": {"Coder": "writer"}})
    assert provider.identity_signature() != first

    assert set(first) == {"plur1bus_identity_v1"}
    assert "writer" not in repr(first)
    assert "secret" not in repr(first)
    assert "https" not in repr(first)


def test_identity_signature_is_read_only_and_works_before_provider_initialization(tmp_path, monkeypatch):
    provider = Plur1busMemoryProvider()
    provider._hermes_home = tmp_path
    _write(tmp_path / "plugins" / "plur1bus" / "config.json", {"agentAliases": {"a": "b"}})

    def fail_if_initialized(*args, **kwargs):
        raise AssertionError("signature must not initialize runtime")

    monkeypatch.setattr("plur1bus_hermes.provider.Plur1busRuntime", fail_if_initialized)
    before = sorted(str(path.relative_to(tmp_path)) for path in tmp_path.rglob("*"))
    signature = provider.identity_signature()
    after = sorted(str(path.relative_to(tmp_path)) for path in tmp_path.rglob("*"))
    assert signature["plur1bus_identity_v1"]
    assert before == after
    assert provider._runtime is None
