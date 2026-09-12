"""Live GitHub tap fetch/scan/install smoke, isolated from every real profile.

Run with the Hermes source tree on PYTHONPATH and its runtime dependencies.
This intentionally exercises a published companion skill, not plugin activation.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import tempfile


def main() -> None:
    identifier = "Cyb3rb1ade/plur1bus-hermes-skills/skills/plur1bus-hermes"
    with tempfile.TemporaryDirectory(prefix="plur1bus-hub-smoke-") as directory:
        previous = os.environ.get("HERMES_HOME")
        os.environ["HERMES_HOME"] = directory
        try:
            from hermes_constants import get_hermes_home
            from tools.skills_hub import HubLockFile
            from tools.skills_hub_github import GitHubAuth, GitHubSource
            from tools.skills_hub_install import install_from_quarantine, quarantine_bundle
            from tools.skills_guard import scan_skill, should_allow_install

            assert Path(get_hermes_home()).resolve() == Path(directory).resolve()
            source = GitHubSource(GitHubAuth())
            source.taps = [{"repo": "Cyb3rb1ade/plur1bus-hermes-skills", "path": "skills/"}]
            results = source.search("plur1bus")
            assert any(item.identifier == identifier for item in results), results
            bundle = source.fetch(identifier)
            assert bundle is not None and bundle.name == "plur1bus-hermes"
            assert set(bundle.files) == {"SKILL.md"}, bundle.files.keys()
            quarantined = quarantine_bundle(bundle)
            scan = scan_skill(quarantined, source=identifier)
            allowed, reason = should_allow_install(scan)
            assert allowed, reason
            destination = install_from_quarantine(quarantined, bundle.name, "", bundle, scan)
            assert destination.resolve().is_relative_to(Path(directory).resolve())
            expected = (Path(__file__).parent / "plur1bus-hermes/SKILL.md").read_bytes()
            installed = (destination / "SKILL.md").read_bytes()
            assert installed == expected
            assert HubLockFile().get_installed(bundle.name) is not None
            print(json.dumps({"identifier": identifier, "search": "passed", "fetch": "passed",
                              "scan": str(scan.verdict), "isolatedInstall": "passed",
                              "sha256": hashlib.sha256(installed).hexdigest()}))
        finally:
            if previous is None:
                os.environ.pop("HERMES_HOME", None)
            else:
                os.environ["HERMES_HOME"] = previous


if __name__ == "__main__":
    main()
