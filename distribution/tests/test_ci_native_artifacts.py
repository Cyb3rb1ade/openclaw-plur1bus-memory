"""Pinned CI native-artifact selection has no latest/fallback path."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
from unittest.mock import patch

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "distribution"))
SPEC = importlib.util.spec_from_file_location("distribution_ci", ROOT / "distribution" / "ci.py")
ci = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ci)


def candidate(tmp_path, filename, source, sha):
    tmp_path.mkdir(parents=True, exist_ok=True)
    wheel = tmp_path / filename; wheel.write_bytes(b"fixture")
    (tmp_path / "UPSTREAM_COMMIT.txt").write_text(source + "\n", encoding="utf-8")
    (tmp_path / "SHA256SUMS").write_text(f"{sha}  {filename}\n", encoding="utf-8")
    return wheel


def test_non_native_targets_refuse_even_partially_supplied_artifact_environment():
    assert ci.native_inputs({}, system="linux", architecture="x86_64") == {}
    with pytest.raises(ValueError, match="not approved"):
        ci.native_inputs({"PLUR1BUS_INTEL_LANCEDB_WHEEL": "/foreign.whl"}, system="linux", architecture="x86_64")


def test_intel_requires_complete_pinned_source_and_hash_validated_wheel(tmp_path):
    wheel = candidate(tmp_path, "lancedb-0.34.0-cp39-abi3-macosx_10_15_x86_64.whl", ci.INTEL_SOURCE, ci.INTEL_SHA256)
    env = {"PLUR1BUS_INTEL_LANCEDB_WHEEL": str(wheel), "PLUR1BUS_INTEL_LANCEDB_SOURCE": str(tmp_path / "UPSTREAM_COMMIT.txt")}
    with patch.object(ci, "validate_intel_wheel", return_value=wheel) as validate:
        assert ci.native_inputs(env, system="darwin", architecture="x86_64") == {"intel_wheel": wheel, "intel_sha256": ci.INTEL_SHA256}
    validate.assert_called_once_with(str(wheel), ci.INTEL_SHA256)
    with pytest.raises(ValueError, match="incomplete"):
        ci.native_inputs({}, system="darwin", architecture="x86_64")
    (tmp_path / "UPSTREAM_COMMIT.txt").write_text("unapproved\n", encoding="utf-8")
    with patch.object(ci, "validate_intel_wheel", return_value=wheel), pytest.raises(ValueError, match="source commit"):
        ci.native_inputs(env, system="darwin", architecture="x86_64")


def test_windows_arm_requires_the_exact_lance_and_arrow_pair(tmp_path):
    lance = candidate(tmp_path / "lance", "lancedb-0.34.0-cp39-abi3-win_arm64.whl", ci.ARM_LANCEDB_SOURCE, ci.ARM_LANCEDB_SHA256)
    arrow = candidate(tmp_path / "arrow", "pyarrow-25.0.1-cp313-cp313-win_arm64.whl", ci.ARM_PYARROW_SOURCE, ci.ARM_PYARROW_SHA256)
    env = {"PLUR1BUS_ARM_LANCEDB_WHEEL": str(lance), "PLUR1BUS_ARM_LANCEDB_SOURCE": str(lance.parent / "UPSTREAM_COMMIT.txt"),
           "PLUR1BUS_ARM_PYARROW_WHEEL": str(arrow), "PLUR1BUS_ARM_PYARROW_SOURCE": str(arrow.parent / "UPSTREAM_COMMIT.txt")}
    with patch.object(ci, "validate_windows_arm_wheel", side_effect=[lance, arrow]) as validate:
        result = ci.native_inputs(env, system="win32", architecture="ARM64")
    assert result["arm_lancedb_wheel"] == lance and result["arm_pyarrow_wheel"] == arrow
    assert validate.call_args_list[0].args == (str(lance), ci.ARM_LANCEDB_SHA256, "lancedb")
    assert validate.call_args_list[1].args == (str(arrow), ci.ARM_PYARROW_SHA256, "pyarrow")


def test_checksum_manifest_accepts_exact_cargo_path_not_arbitrary_suffix(tmp_path):
    wheel = candidate(tmp_path, "lancedb.whl", ci.INTEL_SOURCE, ci.INTEL_SHA256)
    manifest = tmp_path / "SHA256SUMS"
    manifest.write_text(f"{ci.INTEL_SHA256}  target/wheels/{wheel.name}\n")
    ci._checksum_manifest(wheel, ci.INTEL_SHA256)
    for prefix in ("../", "foreign/", "/target/wheels/"):
        manifest.write_text(f"{ci.INTEL_SHA256}  {prefix}{wheel.name}\n")
        with pytest.raises(ValueError, match="checksum manifest"):
            ci._checksum_manifest(wheel, ci.INTEL_SHA256)


@pytest.mark.parametrize("status", [b" M distribution/installer.py\n", b"?? native-candidates/\n"])
def test_ci_refuses_dirty_source_or_downloads_inside_checkout(status):
    with patch.object(ci.subprocess, "check_output", return_value=status), pytest.raises(ValueError, match="not clean"):
        ci.require_clean_source()


def test_ci_accepts_clean_source():
    with patch.object(ci.subprocess, "check_output", return_value=b""):
        ci.require_clean_source()
