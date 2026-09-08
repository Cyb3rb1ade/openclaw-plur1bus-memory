"""Prevent the missing/self-referential checksum manifest published with .2."""
import importlib.util
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location('release_checksums', Path(__file__).parents[1] / 'release_checksums.py')
checksums = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checksums)


def test_asset_manifest_roundtrip_and_tampering(tmp_path):
    (tmp_path / 'package.zip').write_bytes(b'package')
    checksums.write_manifest(tmp_path, ['package.zip'])
    assert checksums.verify_manifest(tmp_path) == ['package.zip']
    (tmp_path / 'package.zip').write_bytes(b'changed')
    with pytest.raises(ValueError):
        checksums.verify_manifest(tmp_path)


@pytest.mark.parametrize('names', [[], ['missing.pkg'], ['SHA256SUMS'], ['../escape'], ['x', 'x']])
def test_bad_selections_are_rejected(tmp_path, names):
    with pytest.raises(ValueError):
        checksums.write_manifest(tmp_path, names)
