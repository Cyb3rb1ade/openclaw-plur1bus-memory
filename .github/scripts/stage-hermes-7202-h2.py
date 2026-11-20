"""Assemble only artifacts whose run and internal manifest bind to this release."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tarfile
import zipfile


repo, commit = Path(sys.argv[1]), sys.argv[2]
root = Path(__file__).parent
version = "7.20.2-hermes.2"
stem = f"plur1bus-{version}"
repository = "Cyb3rb1ade/openclaw-plur1bus-memory"
matrix_run, arm_run = sys.argv[3:5]
runners = ("ubuntu-24.04", "ubuntu-24.04-arm", "ubuntu-24.04-py314",
           "ubuntu-24.04-arm-py314", "macos-15", "macos-15-py314",
           "windows-2025", "windows-2025-py314", "windows-11-arm")
publish = root / "publish"
mac = root / "macos"
arm = root / "ci" / "windows-pm"


def cmd(*args):
    return subprocess.check_output(args, cwd=repo, text=True).strip()


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def download(run, artifact, directory):
    if not (directory / "SHA256SUMS").is_file():
        cmd("gh", "run", "download", run, "-R", repository, "-n", artifact, "-D", str(directory))
    cmd(sys.executable, "distribution/release_checksums.py", str(directory))


def inspect_files(entries, path):
    hashes, manifest = {}, None
    for name, stream in entries:
        top, relative = name.removeprefix("./").split("/", 1)
        assert top == stem and ".." not in relative.split("/"), (path, name)
        with stream:
            if relative == "distribution.json":
                assert manifest is None, path
                manifest = json.load(stream)
            else:
                assert relative not in hashes, (path, relative)
                hashes[relative] = hashlib.file_digest(stream, "sha256").hexdigest()
    assert manifest["sourceCommit"] == commit and manifest["dirty"] is False, path
    assert manifest["version"] == version and manifest["pythonVersion"] == "7.20.2.post2", path
    assert manifest["files"] == hashes, path
    required = {p.name: str(p.relative_to(repo)) for p in (repo / "distribution").glob("runtime_*.py")}
    required["installer.py"] = "distribution/installer.py"
    required.update({
        "payload/plugins/plur1bus/dashboard/plugin_api.py": "hermes-dashboard/plur1bus/dashboard/plugin_api.py",
        "payload/plugins/plur1bus/neo_retention.py": "plur1bus-hermes/src/plur1bus_hermes/neo_retention.py",
        "payload/plugins/plur1bus/operator_status.py": "plur1bus-hermes/src/plur1bus_hermes/operator_status.py",
        "payload/plugins/plur1bus/desktop/plugin.js": "hermes-dashboard/plur1bus/desktop/plugin.js",
        "INSTALLATION.de.md": "distribution/INSTALLATION.de.md",
    })
    # Windows checkout can preserve its text line ending convention.
    for packaged, source in required.items():
        data = (repo / source).read_bytes()
        candidates = {hashlib.sha256(raw).hexdigest() for raw in
                      (data, data.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n"))}
        assert hashes[packaged] in candidates, (path, packaged)
    return manifest


def inspect_archive(path):
    if path.suffix == ".zip":
        with zipfile.ZipFile(path) as archive:
            return inspect_files(((item.filename, archive.open(item)) for item in archive.infolist() if not item.is_dir()), path)
    with tarfile.open(path, "r|gz") as archive:
        return inspect_files(((item.name, archive.extractfile(item)) for item in archive if item.isfile()), path)


def verify_pe(path, machine):
    with path.open("rb") as file:
        assert file.read(2) == b"MZ", path
        file.seek(0x3C)
        file.seek(struct.unpack("<I", file.read(4))[0])
        assert file.read(6) == b"PE\0\0" + struct.pack("<H", machine), path


def verify_native(directory, label, hermes_revision):
    lifecycle = read_json(directory / "native-pm-lifecycle.json")
    assert lifecycle["status"] == "passed" and lifecycle["packageSourceCommit"] == commit, label
    assert lifecycle["sourceCommit"] == hermes_revision, label
    assert set(lifecycle["profiles"]) == {"default", "alpha"}, label
    assert lifecycle["configHashesUnchanged"] is True, label
    assert lifecycle["originalPid"] != lifecycle["restoredPid"], label
    if not label.startswith("windows"):
        assert lifecycle["fixturePmAdmission"] is True, label
        assert lifecycle["ownerDeathSupervisor"] == "stock-spawn-eof-reap-orphan-refusal-and-restore", label
    primitive = read_json(directory / "native-client-primitive.json")
    assert primitive["status"] == "passed" and primitive["packageSourceCommit"] == commit, label
    assert primitive["targetExited"] is True and primitive["unrelatedPreserved"] is True, label
    if label.startswith("windows"):
        assert primitive["windowsCliRefusal"] == "passed-before-shutdown", label
    for kind in ("pm-lifecycle", "client-primitive"):
        shutil.copyfile(directory / f"native-{kind}.json", publish / f"native-{label}-{kind}.json")


assert cmd("git", "merge-base", "--is-ancestor", "e131cae6463c35037bdd7e8cb45fb2a55b67f262", commit) == ""
assert cmd("git", "rev-parse", "HEAD") == commit and not cmd("git", "status", "--porcelain")
for run, count in ((matrix_run, 9), (arm_run, 1)):
    record = json.loads(cmd("gh", "run", "view", run, "-R", repository, "--json", "headSha,conclusion,jobs"))
    assert record["headSha"] == commit and record["conclusion"] == "success", record["conclusion"]
    assert len(record["jobs"]) == count and all(job["conclusion"] == "success" for job in record["jobs"])
tasks = [(matrix_run, f"plur1bus-hermes-{runner}", root / "ci" / runner) for runner in runners]
tasks.append((arm_run, "plur1bus-hermes-windows-arm64-pm-acceptance", arm))
with ThreadPoolExecutor(max_workers=5) as pool:
    for future in [pool.submit(download, *task) for task in tasks]:
        future.result()
publish.mkdir(exist_ok=True)
for runner in runners:
    report = root / "ci" / runner / "verification.json"
    evidence = read_json(report)
    assert evidence["sourceCommit"] == commit, runner
    if runner.startswith("windows"):
        assert evidence["nativeExecutableSmoke"] and not evidence["signed"], runner
    shutil.copyfile(report, publish / f"ci-{runner}.json")
    if runner.endswith("-py314"):
        verify_native(root / "ci" / runner, runner, "2bd378ed1b8d6bf2192cb26e0a55ff3091e6bd19")
provenance = read_json(arm / "source-pinned-provenance.json")
assert provenance["packageSource"]["revision"] == commit and not provenance["packageSource"]["dirty"]
assert provenance["windowsArmCi"]["nativeExecutionVerified"]
assert provenance["hermes"]["revision"] == "2bd378ed1b8d6bf2192cb26e0a55ff3091e6bd19"
arm_smoke = read_json(arm / "hermes-pm-acceptance.json")
assert len(arm_smoke["installedProfiles"]) == 2
assert all(arm_smoke["runtimeSmoke"][field] for field in ("captureRecall", "agentScopeIsolation"))
verify_native(arm, "windows-arm64", "2bd378ed1b8d6bf2192cb26e0a55ff3091e6bd19")
frozen = read_json(arm / "native-frozen-reapply.json")
assert frozen["status"] == "passed" and frozen["packageSourceCommit"] == commit
assert frozen["outcome"] == "installed-restored" and frozen["retainedReceipt"] is True
assert set(frozen["profiles"]) == {"default", "qa-second"}
shutil.copyfile(arm / "native-frozen-reapply.json", publish / "native-windows-arm64-frozen-reapply.json")
for target, path in (
    ("linux-x64", root / "ci" / "ubuntu-24.04"),
    ("linux-arm64", root / "ci" / "ubuntu-24.04-arm"),
    ("macos-arm64", root / "ci" / "macos-15"),
    ("windows-x64", root / "ci" / "windows-2025"),
    ("windows-arm64", arm),
):
    source_stem = stem if target.startswith("linux") else f"{stem}-{target}"
    manifests = []
    for extension in ("zip", "tar.gz"):
        src = path / f"{source_stem}.{extension}"
        manifests.append(inspect_archive(src))
        shutil.copyfile(src, publish / f"{stem}-{target}.{extension}")
    assert manifests[0] == manifests[1], target
    if target.startswith("windows"):
        name = f"{source_stem}-setup-unsigned.exe"
        verify_pe(path / name, 0xAA64 if target.endswith("arm64") else 0x8664)
        shutil.copyfile(path / name, publish / name)
    print("Verified", target, flush=True)
pkg = mac / f"{stem}-macos-arm64.pkg"
payload = read_json(mac / "pkg-payload-acceptance.json")
installer_commit = "c8366c240a892862c1cb22036f0efc63ad105b57"
changed_file = "plur1bus-hermes/tests/test_upstream_761_inventory.py"
assert cmd("git", "rev-parse", f"{commit}^") == installer_commit
assert cmd("git", "diff", "--name-only", installer_commit, commit) == changed_file
assert payload["sourceCommit"] == installer_commit and payload["status"] == "passed"
assert payload["packageSha256"] == "0622157d1e8c7ffa5fa6fb6a986839027e2ba173ac525b8e440bb5135c46e41a"
equivalence = read_json(mac / "macos-parent-artifact-equivalence.json")
assert equivalence == {
    "version": version,
    "installerSource": installer_commit,
    "releaseCommit": commit,
    "changedFiles": [changed_file],
    "verifiedPayloadFiles": payload["verifiedFiles"],
    "sha256": payload["packageSha256"],
    "notarization": "Accepted",
}
shutil.copyfile(mac / "macos-parent-artifact-equivalence.json", publish / "macos-parent-artifact-equivalence.json")
with pkg.open("rb") as file:
    assert payload["packageSha256"] == hashlib.file_digest(file, "sha256").hexdigest()
assert payload["verifiedFiles"] == len(inspect_archive(root / "ci" / "macos-15" / f"{stem}-macos-arm64.zip")["files"])
assert read_json(mac / "notarization-macos-arm64.json")["status"] == "Accepted"
for src in (pkg, mac / "notarization-macos-arm64.json", mac / "pkg-payload-acceptance.json",
            mac / "signature-verification.txt", arm / "hermes-pm-acceptance.json",
            arm / "source-pinned-provenance.json", arm / "native-executable-plan.json",
            repo / "distribution/INSTALLATION.de.md"):
    shutil.copyfile(src, publish / src.name)
npm_pack, = read_json(root / "npm-ci-pack" / "pack.json")
assert npm_pack["version"] == version and npm_pack["filename"] == f"cyb3rb1ade-plur1bus-memory-{version}.tgz"
assert npm_pack["name"] == "@cyb3rb1ade/plur1bus-memory"
from base64 import b64encode
tgz = root / "npm-ci-pack" / npm_pack["filename"]
with tgz.open("rb") as file:
    assert npm_pack["integrity"] == "sha512-" + b64encode(hashlib.file_digest(file, "sha512").digest()).decode()
shutil.copyfile(tgz, publish / tgz.name)
shutil.copyfile(repo / "distribution/README.md", publish / "README.en.md")
names = sorted(path.name for path in publish.iterdir() if path.name != "SHA256SUMS")
print(cmd(sys.executable, "distribution/release_checksums.py", str(publish), "--write", *names))
(root / "release-verification.json").write_text(json.dumps({"sourceCommit": commit, "version": version, "assets": sorted([*names, "SHA256SUMS"]), "matrixRun": matrix_run, "windowsArmPmRun": arm_run}, indent=2) + "\n")
