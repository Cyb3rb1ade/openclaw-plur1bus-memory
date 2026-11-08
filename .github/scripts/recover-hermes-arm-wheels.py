#!/usr/bin/env python3
"""Recover the four hash-pinned native wheels from an immutable release snapshot."""
import argparse
import hashlib
import json
from pathlib import Path
from zipfile import ZipFile

TAG = "7.18.4-hermes.0"
ARCHIVE = f"plur1bus-{TAG}-windows-arm64.zip"
SHA256 = "c0995a5a1cfaab1b91d1a4edc05ba42aaf9c3151a8427f03d46f40085e7a2afb"
PROVENANCE_SHA256 = "000e98b0ebc3472309fc05819fde348664b9475fe2348580bc308eb05f60be72"
LANCE = "lancedb-0.34.0-cp39-abi3-win_arm64.whl"
ARROW_313 = "pyarrow-25.0.1-cp313-cp313-win_arm64.whl"
ARROW_314 = "pyarrow-25.0.1-cp314-cp314-win_arm64.whl"
LANCE_SOURCE = "1545bd4b4fc3344420d1a65506d54b85f57edc54"
ARROW_SOURCE = "beccec0d0c451b7aa3e4530416ac431b3c035c69"
WHEELS = {
    "classic-lancedb": (LANCE, LANCE_SOURCE, "ef9924e292e2a2815a4b6ff92d0d8a1bce0a4d4193eb254556c6a32d61a2d0d2"),
    "classic-pyarrow": (ARROW_313, ARROW_SOURCE, "44188cd110e818101d5d2ca170929546d18c660e3e931b4f4e0d894de7745173"),
    "pm-lancedb": (LANCE, LANCE_SOURCE, "a0399bbb26dc2a8fdf4730accaa76c01969f7a205cdaa3b77f36cc34dd815386"),
    "pm-pyarrow": (ARROW_314, ARROW_SOURCE, "e341fd7ebb9d98a231bba0a06bd8ed29e01afacfa1e530fd8948b4f6e5e4e794"),
}


def _check(path, digest):
    with path.open("rb") as handle:
        if hashlib.file_digest(handle, "sha256").hexdigest() != digest:
            raise ValueError(f"approved input hash mismatch: {path.name}")


def recover(inputs, output):
    """Write exact allowlisted wheels only; never extract other ZIP paths."""
    archive = inputs / ARCHIVE
    provenance = inputs / "source-pinned-provenance.json"
    _check(archive, SHA256)
    _check(provenance, PROVENANCE_SHA256)
    record = json.loads(provenance.read_text(encoding="utf-8-sig"))
    approved = {(r["wheel"], r["source"], r["sha256"]) for r in record["nativeArtifacts"]}
    if approved != set(WHEELS.values()):
        raise ValueError("published provenance does not bind the approved wheels")
    output.mkdir(parents=True, exist_ok=False)
    with ZipFile(archive) as bundle:
        for key, (filename, source, digest) in WHEELS.items():
            prefix = "payload/plugins/plur1bus/" if key.startswith("pm-") else ""
            member = f"plur1bus-{TAG}/{prefix}vendor/windows-arm64/{filename}"
            info = bundle.getinfo(member)
            if not 0 < info.file_size < 70_000_000:
                raise ValueError("wheel exceeds approved size bound")
            data = bundle.read(info)
            if hashlib.sha256(data).hexdigest() != digest:
                raise ValueError(f"wheel digest mismatch: {key}")
            directory = output / key
            directory.mkdir()
            (directory / filename).write_bytes(data)
            (directory / "UPSTREAM_COMMIT.txt").write_text(source + "\n", encoding="ascii")
            (directory / "SHA256SUMS").write_text(f"{digest}  {filename}\n", encoding="ascii")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inputs", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    recover(args.inputs, args.output)
