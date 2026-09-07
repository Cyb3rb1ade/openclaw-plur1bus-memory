#!/usr/bin/env python3
"""Cross-platform candidate build gate, with no publishing or production install."""
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import venv

from build import build, REPO, validate_intel_wheel, validate_windows_arm_wheel
from verify import verify

INTEL_SOURCE = "1545bd4b4fc3344420d1a65506d54b85f57edc54"
INTEL_SHA256 = "dd63002235ead23d208c06ed39b80dae0ec98ed81806f7c159f0f4c7e24b04ba"
ARM_LANCEDB_SOURCE = "1545bd4b4fc3344420d1a65506d54b85f57edc54"
ARM_LANCEDB_SHA256 = "ef9924e292e2a2815a4b6ff92d0d8a1bce0a4d4193eb254556c6a32d61a2d0d2"
ARM_PYARROW_SOURCE = "beccec0d0c451b7aa3e4530416ac431b3c035c69"
ARM_PYARROW_SHA256 = "44188cd110e818101d5d2ca170929546d18c660e3e931b4f4e0d894de7745173"
_NATIVE_ENV = ("PLUR1BUS_INTEL_LANCEDB_WHEEL", "PLUR1BUS_INTEL_LANCEDB_SOURCE",
               "PLUR1BUS_ARM_LANCEDB_WHEEL", "PLUR1BUS_ARM_LANCEDB_SOURCE",
               "PLUR1BUS_ARM_PYARROW_WHEEL", "PLUR1BUS_ARM_PYARROW_SOURCE")


def _required(environment, *names):
    """Read nonempty CI-only artifact inputs; never fall back to a latest wheel."""
    values = {name: environment.get(name, "").strip() for name in names}
    if not all(values.values()):
        raise ValueError("pinned native artifact environment is incomplete")
    return values


def _source_file(path, expected_source):
    """Verify the upstream commit supplied inside the reviewed artifact itself."""
    source = Path(path)
    if source.name != "UPSTREAM_COMMIT.txt" or not source.is_file():
        raise ValueError("native artifact source file is missing")
    if source.read_text(encoding="utf-8").strip() != expected_source:
        raise ValueError("native artifact source commit is not approved")


def _checksum_manifest(wheel, expected):
    """Require the candidate's recorded checksum before a pip invocation."""
    wheel = Path(wheel)
    manifest = wheel.parent / "SHA256SUMS"
    # Cargo's Intel build records its build-relative wheel path; ARM records
    # the basename. Accept only these exact spellings, never arbitrary suffixes.
    approved = {f"{expected}  {wheel.name}", f"{expected}  target/wheels/{wheel.name}"}
    if not manifest.is_file() or not approved.intersection(manifest.read_text(encoding="utf-8").splitlines()):
        raise ValueError("native artifact checksum manifest is not approved")


def native_inputs(environment=None, *, system=None, architecture=None):
    """Return only target-approved native build inputs, validating wheel provenance first."""
    environment = os.environ if environment is None else environment
    system = sys.platform if system is None else system
    architecture = platform.machine() if architecture is None else architecture
    target = (system, architecture.lower())
    supplied = any(str(environment.get(name, "")).strip() for name in _NATIVE_ENV)
    if target == ("darwin", "x86_64"):
        values = _required(environment, "PLUR1BUS_INTEL_LANCEDB_WHEEL", "PLUR1BUS_INTEL_LANCEDB_SOURCE")
        wheel = validate_intel_wheel(values["PLUR1BUS_INTEL_LANCEDB_WHEEL"], INTEL_SHA256)
        _source_file(values["PLUR1BUS_INTEL_LANCEDB_SOURCE"], INTEL_SOURCE)
        _checksum_manifest(wheel, INTEL_SHA256)
        return {"intel_wheel": wheel, "intel_sha256": INTEL_SHA256}
    if target == ("win32", "arm64"):
        values = _required(environment, "PLUR1BUS_ARM_LANCEDB_WHEEL", "PLUR1BUS_ARM_LANCEDB_SOURCE",
                           "PLUR1BUS_ARM_PYARROW_WHEEL", "PLUR1BUS_ARM_PYARROW_SOURCE")
        lance = validate_windows_arm_wheel(values["PLUR1BUS_ARM_LANCEDB_WHEEL"], ARM_LANCEDB_SHA256, "lancedb")
        arrow = validate_windows_arm_wheel(values["PLUR1BUS_ARM_PYARROW_WHEEL"], ARM_PYARROW_SHA256, "pyarrow")
        _source_file(values["PLUR1BUS_ARM_LANCEDB_SOURCE"], ARM_LANCEDB_SOURCE)
        _source_file(values["PLUR1BUS_ARM_PYARROW_SOURCE"], ARM_PYARROW_SOURCE)
        _checksum_manifest(lance, ARM_LANCEDB_SHA256); _checksum_manifest(arrow, ARM_PYARROW_SHA256)
        return {"arm_lancedb_wheel": lance, "arm_lancedb_sha256": ARM_LANCEDB_SHA256,
                "arm_pyarrow_wheel": arrow, "arm_pyarrow_sha256": ARM_PYARROW_SHA256}
    if supplied:
        raise ValueError("pinned native wheel inputs are not approved for this target")
    return {}


def provision_native(environment=None, *, system=None, architecture=None):
    """Validate reviewed native artifacts and install only the exact local wheels."""
    inputs = native_inputs(environment, system=system, architecture=architecture)
    wheels = [inputs[key] for key in ("intel_wheel", "arm_lancedb_wheel", "arm_pyarrow_wheel") if key in inputs]
    if wheels:
        subprocess.run([sys.executable, "-m", "pip", "install", "--no-deps", "--force-reinstall", *map(str, wheels)], check=True)
    return inputs


def require_clean_source():
    """CI must never certify a candidate containing uncommitted source changes."""
    if subprocess.check_output(["git", "status", "--porcelain"], cwd=REPO):
        raise ValueError("candidate CI checkout is not clean; do not publish its artifacts")


def fresh_cpu_torch_smoke(bundle):
    """Install the built bundle into a no-Torch Linux x64 venv, not CI's venv."""
    if sys.platform != "linux" or platform.machine().lower() not in {"x86_64", "amd64"}:
        return False
    with tempfile.TemporaryDirectory(prefix="plur1bus-fresh-cpu-torch-") as temporary:
        root = Path(temporary)
        environment = root / "venv"
        venv.EnvBuilder(with_pip=True).create(environment)
        python = environment / "bin" / "python"
        subprocess.run([str(python), "-I", "-m", "pip", "install", "--disable-pip-version-check", "PyYAML>=6,<7"], check=True)
        absent = subprocess.check_output([str(python), "-I", "-c",
            "import importlib.metadata as m; "
            "\ntry: m.version('torch')\nexcept m.PackageNotFoundError: print('absent')\nelse: raise SystemExit('Torch inherited into fresh venv')"],
            text=True).strip()
        if absent != "absent":
            raise ValueError("fresh CPU Torch smoke inherited Torch")
        home = root / "hermes-home"
        home.mkdir()
        (home / "config.yaml").write_text("memory: {}\nplugins: {}\n", encoding="utf-8")
        command = [str(python), str(bundle / "installer.py"), "--home", str(home), "--python", str(python),
                   "--profile", "default"]
        plan = json.loads(subprocess.check_output(command, text=True))
        if plan.get("torch", {}).get("action") != "install-cpu":
            raise ValueError("fresh Linux x64 plan did not bind CPU Torch")
        subprocess.run([*command, "--apply", "--confirm", plan["confirmation"], "--runtimes-stopped"], check=True)
        subprocess.run([str(python), "-I", "-c", """
import importlib.metadata as metadata, torch
assert torch.version.cuda is None and torch.version.hip is None
assert torch.__version__.endswith('+cpu')
assert not [dist.metadata['Name'] for dist in metadata.distributions()
            if (dist.metadata.get('Name') or '').lower().startswith(('nvidia-', 'cuda-'))]
print('fresh CPU Torch bundle install passed')
"""], check=True)
    return True


def main():
    native = provision_native()
    environment = os.environ.copy()
    environment["PYTHONPATH"] = os.pathsep.join(str(REPO / name / "src") for name in ("plur1bus-hermes", "plur1bus-controls"))
    subprocess.run([sys.executable, "-m", "pytest", "-q", "plur1bus-hermes/tests", "plur1bus-controls/tests",
                    "distribution/tests"], cwd=REPO, env=environment, check=True)
    output = REPO / "distribution-artifacts"
    require_clean_source()
    bundle = build(output, mac_pkg=sys.platform == "darwin", windows_exe=sys.platform == "win32", **native)
    if json.loads((bundle / "distribution.json").read_text(encoding="utf-8"))["dirty"]:
        raise ValueError("candidate source changed during packaging")
    executable = next(output.glob("*.exe")) if sys.platform == "win32" else None
    fresh_cpu_torch_ran = fresh_cpu_torch_smoke(bundle)
    verify(bundle, executable)
    # Evidence is uploaded alongside, not folded into checksums of package files.
    (output / "verification.json").write_text(json.dumps({
        "platform": sys.platform, "architecture": platform.machine(), "python": sys.version,
        "sourceCommit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip(),
        "gates": ["python-regressions", "bundle-checksums", "real-wheel-install",
                  *(["fresh-cpu-torch-install"] if fresh_cpu_torch_ran else []),
                  "real-lancedb-stub-embedding-smoke", "file-rollback"],
        "nativeExecutableSmoke": bool(executable), "published": False, "signed": False,
    }, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    if "--provision-native" in sys.argv[1:]:
        provision_native()
    else:
        main()
