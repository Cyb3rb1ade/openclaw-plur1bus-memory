"""Offline export/restore acceptance, including real LanceDB and crash recovery."""
import json
import os
from pathlib import Path
from unittest.mock import patch

import lancedb
import pytest

from plur1bus_hermes import snapshot as api
from plur1bus_hermes.restore_guard import restore_guard_path
from plur1bus_hermes.runtime_lease import acquire_runtime_lease, exclusive_generation_lease
from plur1bus_hermes.writer_lock import writer_lock


@pytest.fixture
def sample(tmp_path):
    root = tmp_path.resolve()
    data, config, bundle = root / "data", root / "profile.json", root / "snapshot"
    data.mkdir()
    (data / "_tombstones").mkdir()
    (data / "_tombstones/main.jsonl").write_text('{"deleted":"preserve me"}\n')
    (data / "empty-directory").mkdir()
    (data / "poetry.lock").write_text("not a runtime lock, preserve this")
    (data / "state").mkdir()
    (data / "state/capture-retry.jsonl").write_text('{"pending":"must survive"}\n')
    config.write_text('{"model":"original","secret":"private fixture only"}')
    lancedb.connect(str(data / "lancedb/main")).create_table("memories", [{
        "id": "row1", "scopeKey": "private-main", "content": "original",
        "vector": [0.5, 0.2], "epistemicStatus": "observed", "validUntil": 100,
    }])
    return data, config, bundle


def exported(sample):
    data, config, bundle = sample
    plan = api.plan_export([data], [config], bundle)
    result = api.export_snapshot([data], [config], bundle, confirmation=plan["confirmation"], stopped=True)
    assert result["complete"]
    return sample


def restore(sample, *, mutate=True):
    data, config, bundle = exported(sample)
    if mutate:
        config.write_text('{"model":"new user config"}')
        (data / "after-export.txt").write_text("keep in backup")
    plan = api.plan_restore(bundle, [data], [config])
    return plan


def test_preview_is_read_only_and_export_requires_exact_approval(sample):
    data, config, bundle = sample
    before = sorted(str(p) for p in data.rglob("*"))
    plan = api.plan_export([data], [config], bundle)
    assert not bundle.exists()
    assert sorted(str(p) for p in data.rglob("*")) == before
    with pytest.raises(ValueError, match="approve"):
        api.export_snapshot([data], [config], bundle, confirmation="bad", stopped=True)
    assert not bundle.exists()
    assert "plaintext" in plan["warning"]


def test_export_preserves_db_tombstones_queue_configs_and_artifacts(sample):
    data, config, bundle = exported(sample)
    result = api.verify_snapshot(bundle)
    assert len(result["roots"]) == 2
    assert (bundle / "0/poetry.lock").read_text() == (data / "poetry.lock").read_text()
    assert (bundle / "0/empty-directory").is_dir()
    assert not (bundle / "0/state/runtime-generation.lock").exists()
    assert lancedb.connect(str(bundle / "0/lancedb/main")).open_table("memories").count_rows() == 1
    if os.name != "nt":
        assert bundle.stat().st_mode & 0o777 == 0o700
        assert (bundle / "1").stat().st_mode & 0o777 == 0o600


def test_complete_restore_retains_every_previous_root(sample):
    data, config, bundle = sample
    plan = restore(sample)
    result = api.restore_snapshot(bundle, [data], [config], confirmation=plan["confirmation"], stopped=True)
    assert result["complete"]
    old_data, old_config = map(Path, result["retainedBackups"])
    assert (old_data / "after-export.txt").read_text() == "keep in backup"
    assert json.loads(old_config.read_text())["model"] == "new user config"
    assert not (data / "after-export.txt").exists()
    assert json.loads(config.read_text())["model"] == "original"
    row = lancedb.connect(str(data / "lancedb/main")).open_table("memories").search().limit(1).to_list()[0]
    assert row["scopeKey"] == "private-main" and row["epistemicStatus"] == "observed" and row["validUntil"] == 100
    assert (data / "state/capture-retry.jsonl").read_text() == '{"pending":"must survive"}\n'
    assert not restore_guard_path(data).exists()
    lease = acquire_runtime_lease(data)
    lease.close()


def test_active_runtime_blocks_export_and_restore(sample):
    data, config, bundle = exported(sample)
    plan = api.plan_restore(bundle, [data], [config])
    lease = acquire_runtime_lease(data)
    try:
        with pytest.raises(RuntimeError, match="runtime lease"):
            api.restore_snapshot(bundle, [data], [config], confirmation=plan["confirmation"], stopped=True)
        fresh = bundle.with_name("second")
        export = api.plan_export([data], [config], fresh)
        with pytest.raises(RuntimeError, match="runtime lease"):
            api.export_snapshot([data], [config], fresh, confirmation=export["confirmation"], stopped=True)
        assert not fresh.exists()
        assert not restore_guard_path(data).exists()
    finally:
        lease.close()


@pytest.mark.parametrize("cut", [1, 2, 3, 4])
def test_crash_after_each_root_rename_is_recoverable_and_start_fails_closed(sample, cut):
    data, config, bundle = sample
    plan = restore(sample)
    move = api._move_root
    calls = []
    def crash(src, dest):
        move(src, dest)
        calls.append(str(dest))
        if len(calls) == cut:
            raise OSError("simulated crash after rename")
    with patch.object(api, "_move_root", side_effect=crash):
        with pytest.raises(OSError, match="simulated crash"):
            api.restore_snapshot(bundle, [data], [config], confirmation=plan["confirmation"], stopped=True)
    with pytest.raises(RuntimeError, match="restore is unfinished"):
        acquire_runtime_lease(data)
    with pytest.raises(RuntimeError, match="restore is unfinished"):
        with writer_lock(data):
            pass
    with pytest.raises(RuntimeError, match="restore is unfinished"):
        with exclusive_generation_lease(data):
            pass
    result = api.restore_snapshot(bundle, [data], [config], confirmation=plan["confirmation"], stopped=True, resume=True)
    assert result["complete"]
    assert json.loads(config.read_text())["model"] == "original"
    assert not restore_guard_path(data).exists()


def test_incomplete_copy_is_retained_and_reprepared_on_resume(sample):
    data, config, bundle = sample
    plan = restore(sample)
    def partial(_source, destination, _inventory):
        destination.mkdir()
        (destination / "partial").write_text("incomplete")
        raise OSError("disk full")
    with patch.object(api, "_copy_tree", side_effect=partial):
        with pytest.raises(OSError, match="disk full"):
            api.restore_snapshot(bundle, [data], [config], confirmation=plan["confirmation"], stopped=True)
    assert (data / "after-export.txt").is_file()
    result = api.restore_snapshot(bundle, [data], [config], confirmation=plan["confirmation"], stopped=True, resume=True)
    assert result["complete"]
    assert list(data.parent.glob(".data.plur1bus-*-new-incomplete-*/partial"))


def test_corruption_extra_files_stale_approval_and_wrong_targets_are_refused(sample):
    data, config, bundle = exported(sample)
    with pytest.raises(ValueError, match="locations"):
        api.plan_restore(bundle, [data.with_name("other")], [config])
    plan = api.plan_restore(bundle, [data], [config])
    config.write_text("manual edit after review")
    with pytest.raises(ValueError, match="stale"):
        api.restore_snapshot(bundle, [data], [config], confirmation=plan["confirmation"], stopped=True)
    (bundle / "extra").write_text("unexpected")
    with pytest.raises(ValueError, match="unexpected"):
        api.verify_snapshot(bundle)
    (bundle / "extra").unlink()
    (bundle / "1").write_text("corrupt")
    with pytest.raises(ValueError, match="checksum"):
        api.verify_snapshot(bundle)


def test_overlapping_and_broad_roots_are_refused(sample):
    data, config, bundle = sample
    with pytest.raises(ValueError, match="overlap"):
        api.plan_export([data], [data / "state"], bundle)
    with pytest.raises(ValueError, match="outside"):
        api.plan_export([data], [config], data / "recursive-backup")
    with pytest.raises(ValueError, match="specific"):
        api.plan_export([Path.home()], [], bundle)


@pytest.mark.skipif(os.name == "nt", reason="Windows symlink permission depends on host policy")
def test_symlink_payload_never_follows_outside_files(sample):
    data, config, bundle = sample
    (data / "linked-secret").symlink_to(config)
    with pytest.raises(ValueError, match="links"):
        api.plan_export([data], [config], bundle)
    assert not bundle.exists()


def test_empty_data_root_can_be_exported_without_preview_writes(tmp_path):
    data, bundle = tmp_path.resolve() / "empty", tmp_path.resolve() / "snapshot"
    data.mkdir()
    plan = api.plan_export([data], [], bundle)
    assert not list(data.iterdir())
    assert api.export_snapshot([data], [], bundle, confirmation=plan["confirmation"], stopped=True)["complete"]
