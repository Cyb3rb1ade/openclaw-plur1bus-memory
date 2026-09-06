#!/usr/bin/env python3
"""Review and build a patched Hermes copy; never modify the installed application."""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile

PATCHES = ("hermes-desktop-live-profile.patch", "hermes-desktop-sidebar-action.patch")
COMMANDS = (("npm", "ci"), ("npm", "run", "pack", "--workspace=apps/desktop"))


def run(args, cwd):
    return subprocess.run(args, cwd=cwd, text=True, capture_output=True, check=True)


def resolve_tool(tool):
    """Resolve an executable once; Windows builds must invoke npm.cmd explicitly."""
    candidates = (tool, tool + ".cmd") if sys.platform == "win32" else (tool,)
    for candidate in candidates:
        binary = shutil.which(candidate)
        if binary:
            return binary
    return None


def resolve_inside(base, relative):
    """Reject traversal and symlink components, including nonexistent destinations."""
    part = Path(relative)
    if part.is_absolute() or ".." in part.parts:
        raise ValueError("unsafe relative path")
    target = base
    for name in part.parts:
        target = target / name
        if target.is_symlink():
            raise ValueError("symbolic-link path refused")
    if not target.resolve().is_relative_to(base.resolve()):
        raise ValueError("path escapes root")
    return target


def directory(value):
    path = Path(value).absolute()
    resolve_inside(Path(path.anchor), str(path.relative_to(path.anchor)))
    return path


def patch_root():
    script = Path(__file__).resolve()
    bundled = script.parent.parent / "hermes-dashboard/patches"
    return bundled if bundled.is_dir() else script.parent / "plur1bus-host-patches"


def satisfies(version, requirement):
    """Bounded engine-range parser; unknown syntax fails closed, never bypasses npm engines."""
    if not re.fullmatch(r"v?\d+\.\d+\.\d+", version):
        return False
    actual = tuple(map(int, version.lstrip("v").split(".")))
    for alternative in requirement.split("||"):
        clauses = alternative.split()
        checks = []
        for clause in clauses:
            match = re.fullmatch(r"(>=|<=|>|<|\^|=)?(\d+)\.(\d+)\.(\d+)", clause)
            if not match:
                return False
            op = match[1] or "="
            wanted = tuple(map(int, match.groups()[1:]))
            upper = ((wanted[0] + 1, 0, 0) if wanted[0] else
                     (0, wanted[1] + 1, 0) if wanted[1] else (0, 0, wanted[2] + 1))
            checks.append({">=": actual >= wanted, "<=": actual <= wanted,
                           ">": actual > wanted, "<": actual < wanted,
                           "=": actual == wanted, "^": wanted <= actual < upper}[op])
        if checks and all(checks):
            return True
    return False


def review(source, output, patches=None):
    """Read-only source compatibility and revision-bound execution plan."""
    source, output = directory(source), directory(output)
    if output == source or output.is_relative_to(source):
        raise ValueError("build output must be outside the source checkout")
    if not source.is_dir() or source.suffix.lower() == ".app":
        raise ValueError("a Hermes Git source checkout is required, not an installed app")
    if Path(run(["git", "rev-parse", "--show-toplevel"], source).stdout.strip()).resolve() != source.resolve():
        raise ValueError("source must be the Git checkout root")
    head = run(["git", "rev-parse", "HEAD"], source).stdout.strip()
    dirty = bool(run(["git", "status", "--porcelain", "--untracked-files=normal"], source).stdout)
    package = json.loads(resolve_inside(source, "apps/desktop/package.json").read_text())
    root_package = json.loads(resolve_inside(source, "package.json").read_text())
    engines = root_package.get("engines", {})
    toolchain = {}
    for tool in ("node", "npm"):
        binary = resolve_tool(tool)
        version = run([binary, "--version"], source).stdout.strip() if binary else "missing"
        requirement = engines.get(tool, "")
        toolchain[tool] = {"binary": binary, "version": version, "required": requirement,
                           "supported": satisfies(version, requirement)}
    if package.get("scripts", {}).get("pack") != "npm run build && npm run builder -- --dir --publish never":
        raise ValueError("unsupported Hermes packaging command; manual review required")
    if not resolve_inside(source, "package-lock.json").is_file():
        raise ValueError("locked npm source installation required")
    patch_dir = patches or patch_root()
    states = []
    for name in PATCHES:
        patch = resolve_inside(patch_dir, name)
        content = patch.read_bytes()
        # Even check-mode must not follow a target symlink outside the checkout.
        for line in content.decode().splitlines():
            if line.startswith("+++ b/"):
                resolve_inside(source, line[6:])
        def applicable(reverse=False):
            result = subprocess.run(["git", "apply", "--check", *(["--reverse"] if reverse else []), str(patch)],
                                    cwd=source, capture_output=True)
            return result.returncode == 0
        state = "present" if applicable(True) else "applicable" if applicable() else "incompatible"
        states.append({"name": name, "sha256": hashlib.sha256(content).hexdigest(), "state": state})
    plan = {"schema": 1, "source": str(source), "head": head, "outputRoot": str(output), "toolchain": toolchain,
            "signing": "disabled-local-build",
            "platform": sys.platform, "dirty": dirty, "patches": states,
            "commands": [[toolchain["npm"]["binary"], *command[1:]] for command in COMMANDS]
                        if toolchain["npm"]["binary"] else [list(command) for command in COMMANDS],
            "effects": "Snapshot tracked source, apply patches to copy, download locked npm dependencies and execute trusted Hermes build scripts. No publish, app replacement, profile or memory changes."}
    plan["supported"] = not dirty and all(item["state"] != "incompatible" for item in states) and all(item["supported"] for item in toolchain.values())
    plan["confirmation"] = hashlib.sha256(json.dumps(plan, sort_keys=True).encode()).hexdigest()
    return plan


def build(plan, confirmation, patches=None):
    """Execute only the reviewed plan into a new directory, retaining failure evidence."""
    fresh = review(plan["source"], plan["outputRoot"], patches)
    if not fresh["supported"] or fresh != plan or confirmation != fresh["confirmation"]:
        raise ValueError("unsupported or stale plan / missing exact confirmation; no writes performed")
    source, output = directory(plan["source"]), directory(plan["outputRoot"])
    output.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix="hermes-" + plan["head"][:12] + "-", dir=output))
    stage.chmod(0o700)
    (stage / "plan.json").write_text(json.dumps(plan, indent=2) + "\n")
    print("Build directory (retained on failure): " + str(stage), flush=True)
    journal = stage / "result.json"
    def record(status, **extra):
        journal.write_text(json.dumps({"status": status, "sourceHead": plan["head"], **extra}, indent=2) + "\n")
    record("snapshot")
    try:
        archive = stage / "source-backup.tar"
        run(["git", "archive", "--format=tar", "--output=" + str(archive), plan["head"]], source)
        target = stage / "source"
        target.mkdir()
        with tarfile.open(archive) as tar:
            members = tar.getmembers()
            for member in members:
                resolve_inside(target, member.name)
                if not (member.isfile() or member.isdir()):
                    raise ValueError("archive contains links or special files; manual build required")
            tar.extractall(target, members=members, filter="data")
        patch_dir = patches or patch_root()
        for item in plan["patches"]:
            content = resolve_inside(patch_dir, item["name"]).read_bytes()
            if hashlib.sha256(content).hexdigest() != item["sha256"]:
                raise ValueError("patch changed after review")
            patch = stage / item["name"]
            patch.write_bytes(content)
            if item["state"] == "applicable":
                run(["git", "apply", "--check", str(patch)], target)
                run(["git", "apply", str(patch)], target)
            run(["git", "apply", "--check", "--reverse", str(patch)], target)
        record("building")
        env = {key: value for key, value in os.environ.items()
               if not key.startswith(("CSC_", "WIN_CSC_", "APPLE_"))
               and key not in {"GH_TOKEN", "GITHUB_TOKEN", "GITHUB_SHA", "GITHUB_REF_NAME", "GITHUB_HEAD_REF"}}
        env["CSC_IDENTITY_AUTO_DISCOVERY"] = "false"
        # The isolated archive has no .git, credentials, ignored files, or live app.
        # Build scripts are executable code from the exact explicitly trusted revision.
        with (stage / "build.log").open("w") as log:
            for command in plan["commands"]:
                subprocess.run(command, cwd=target, env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
        release = resolve_inside(target, "apps/desktop/release")
        if not release.is_dir() or not any(release.iterdir()):
            raise ValueError("build produced no packaged application")
        record("built-not-installed", applicationDirectory=str(release))
        print("Built; not installed or started: " + str(release))
        return stage
    except BaseException as error:
        record("failed", errorType=type(error).__name__, recovery="Original source and installed app are unchanged. Inspect build.log; review again before retrying.")
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, help="explicit Hermes Git checkout root")
    parser.add_argument("--output-root", help="outside source; default: sibling <source>-plur1bus-builds")
    parser.add_argument("--apply", action="store_true", help="build an isolated copy after confirmation")
    parser.add_argument("--confirm", default="", help="exact confirmation hash from the read-only plan")
    args = parser.parse_args()
    try:
        source = directory(args.source)
        output = args.output_root or str(source.parent / (source.name + "-plur1bus-builds"))
        plan = review(source, output)
        print(json.dumps(plan, indent=2), flush=True)
        if args.apply:
            build(plan, args.confirm)
        return 0 if plan["supported"] else 4
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print("Host preparation refused/failed: " + str(error), file=sys.stderr)
        return 4


if __name__ == "__main__":
    sys.exit(main())
