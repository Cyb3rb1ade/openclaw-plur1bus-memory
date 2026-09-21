import json
from types import SimpleNamespace

import pytest

from plur1bus_hermes.chunking import _bundle_short, capture_options
from plur1bus_hermes.encoding import refine_patch
from plur1bus_hermes.namespaces import binding_from_scope
from plur1bus_hermes.settings_admin import public_settings, save_setting, validate_change


def test_flashbulb_threshold_and_refine_remain_live():
    below = refine_patch({}, {"importance": .79, "intensity": .79}, 123, flashbulb=True)
    assert below["importanceStatus"] == "final"
    assert "lastDynamicsAt" not in below
    exact = refine_patch({}, {"importance": .8, "intensity": .8}, 123, flashbulb=True)
    assert exact["memoryClass"] == "flashbulb" and exact["lastDynamicsAt"] == 123
    assert exact["halfLifeDays"] == 3650
    assert "memoryClass" not in refine_patch({"importance": .97}, {"importance": .9, "intensity": 1}, 123, flashbulb=True)


def test_short_answers_follow_previous_sentence_but_old_retries_do_not_drift():
    parts = ["An adequately long question?", "Nein.", "A different long question?"]
    assert _bundle_short(parts, 2) == [parts[0] + "\nNein.", parts[2]]
    assert _bundle_short(parts, 1) == [parts[0], "Nein.\n" + parts[2]]
    assert capture_options({})["version"] == 2


def test_reviewed_settings_are_scoped_backed_up_and_not_reported_active(tmp_path):
    path = tmp_path / "plugins/plur1bus/config.json"
    path.parent.mkdir(parents=True)
    original = {"llm": {"model": "local", "apiKey": "not-for-browser"}, "unrelated": 42}
    path.write_text(json.dumps(original))
    view = SimpleNamespace(hermes_home=tmp_path, profile="default", agent_id="default",
        data_dir=tmp_path / "data", config=original, scope_binding=binding_from_scope("default"),
        _writer_route=SimpleNamespace(path=tmp_path / "data/lancedb/default"))
    public = public_settings(view)
    assert "not-for-browser" not in json.dumps(public)
    assert public["activation"] == "unknown"
    for identifier, value in [("security.allowedUsers", []), ("autoCapture", "true"),
                              ("model.*", "unknown/model"), ("capture.mode", "arbitrary")]:
        with pytest.raises(ValueError):
            validate_change(view, identifier, value)
    result = save_setting(view, "capture.mode", "geteilt", public["revision"])
    assert result["saved"] and result["restartRequired"]
    saved = json.loads(path.read_text())
    assert saved["captureChunking"] is True and saved["captureChunkingMode"] == "geteilt"
    assert saved["unrelated"] == 42
    assert json.loads(next(path.parent.glob("config.before-settings-*.json")).read_text()) == original
    with pytest.raises(ValueError):
        save_setting(view, "autoCapture", False, public["revision"])
