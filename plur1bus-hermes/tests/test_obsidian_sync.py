"""Scoped reviewed imports preserve failures, manual files and source revisions."""

from unittest.mock import Mock, patch

import pytest

from plur1bus_hermes.runtime import Plur1busRuntime
from plur1bus_hermes.obsidian_sync import plan_obsidian_sync, apply_obsidian_sync, watch_obsidian, changed_notes
from plur1bus_hermes.obsidian_maintenance import generate_obsidian_control_room


@pytest.fixture
def runtime(tmp_path):
    runtime = Plur1busRuntime(tmp_path, {"embedding": {"dimensions": 2}}, "a")
    runtime._embedding.embed = lambda _text, purpose="passage": [0.1, 0.2]
    runtime._domain.on_memory = Mock()
    yield runtime
    runtime.shutdown()


def note(runtime):
    selector = runtime._domain._scope_selector(acl_bindings=runtime.scope_binding)
    path = runtime._domain._scope_workspace_dir(selector) / "note.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("Workspace evidence", encoding="utf-8")
    return path


def test_scope_bound_review_and_verified_acknowledgement(runtime):
    path = note(runtime)
    plan = plan_obsidian_sync(runtime)
    with pytest.raises(ValueError, match="stale"):
        apply_obsidian_sync(runtime, approved_revision="wrong")
    result = apply_obsidian_sync(runtime, approved_revision=plan["revision"])
    assert len(result["imported"]) == 1 and result["files"] == 1
    assert plan_obsidian_sync(runtime)["files"] == []
    table, _ = runtime._table(False)
    row, = table.search().limit(2).to_list()
    assert row["epistemicStatus"] == "untrusted" and row["scopeKey"] == runtime.scope_key
    path.write_text("Edited evidence")
    assert len(plan_obsidian_sync(runtime)["files"]) == 1


def test_failure_does_not_ack_and_retry_reuses_stable_id(runtime):
    note(runtime)
    plan = plan_obsidian_sync(runtime)
    with patch.object(runtime, "_remember", return_value=None):
        with pytest.raises(RuntimeError, match="unacknowledged"):
            apply_obsidian_sync(runtime, approved_revision=plan["revision"])
    assert plan_obsidian_sync(runtime) == plan
    with patch.object(runtime._domain, "mark_obsidian_synced", side_effect=OSError("full disk")):
        with pytest.raises(OSError):
            apply_obsidian_sync(runtime, approved_revision=plan["revision"])
    apply_obsidian_sync(runtime, approved_revision=plan["revision"])
    table, _ = runtime._table(False)
    assert table.count_rows() == 1


def test_changed_note_requires_new_review_and_watch_never_imports(runtime):
    path = note(runtime)
    old = plan_obsidian_sync(runtime)
    path.write_text("New evidence")
    with pytest.raises(ValueError, match="stale"):
        apply_obsidian_sync(runtime, approved_revision=old["revision"])
    assert watch_obsidian(runtime)["skipped"]
    runtime.config["obsidianBridge"] = {"enabled": True, "watch": True}
    report = watch_obsidian(runtime)
    assert report["pendingFiles"] == 1 and report["imported"] == 0
    assert runtime._table(False)[0] is None


def test_scan_never_reads_links_hidden_generated_or_oversized(tmp_path):
    (tmp_path / "note.md").write_text("okay")
    (tmp_path / ".secret.md").write_text("secret")
    mirror = tmp_path / "plur1bus" / "memories"
    mirror.mkdir(parents=True)
    (mirror / "echo.md").write_text("generated")
    try:
        (tmp_path / "alias.md").symlink_to(tmp_path / ".secret.md")
    except OSError:
        pass  # Windows may not grant the test user symlink creation.
    assert [item["path"] for item in changed_notes(tmp_path, {})] == ["note.md"]
    (tmp_path / "huge.md").write_text("x" * 200001)
    with pytest.raises(ValueError, match="bounded"):
        changed_notes(tmp_path, {})


def test_managed_control_room_preserves_foreign_and_manually_edited_files(tmp_path):
    def generate():
        return generate_obsidian_control_room(tmp_path, "a", metadata_rows=[], episodes=[],
                                              dreams=[], contradictions=[], open_threads=[])
    directory = tmp_path / ".plur1bus" / "control-room"
    directory.mkdir(parents=True)
    foreign = directory / "Dashboard.md"
    foreign.write_text("my own dashboard")
    assert str(foreign) in generate()["conflicts"]
    assert foreign.read_text() == "my own dashboard"
    managed = directory / "Open Threads.md"
    managed.write_text("manual change")
    result = generate()
    assert str(managed) in result["conflicts"]
    assert managed.read_text() == "manual change"
