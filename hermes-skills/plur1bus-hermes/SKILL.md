---
name: plur1bus-hermes
description: Install, update, or diagnose the PLUR1BUS persistent-memory plugin in Hermes, including profile activation, desktop settings, and platform-specific packages. This skill supplies operating instructions, not the memory runtime itself.
metadata:
  hermes:
    tags: [memory, hermes, plur1bus, installation, troubleshooting]
---

# PLUR1BUS for Hermes

Use the Hermes distribution of PLUR1BUS, not its OpenClaw installation procedure.
Installing this skill alone does not install or activate the memory provider.

## Select a release and platform

Read the published [Hermes releases](https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory/releases).
Choose a non-draft tag containing `-hermes.`; the repository's latest OpenClaw
release and GitHub's source-code ZIP are not Hermes installation packages.
Respect an explicitly requested version. Read that release's `INSTALLATION.de.md`,
`DISTRIBUTION-README.md`, and `SHA256SUMS` assets before installing.

| Runtime platform | Distribution |
| --- | --- |
| macOS Apple Silicon | `macos-arm64.pkg`; open **PLUR1BUS einrichten** after Apple finishes staging the app |
| Windows x64 | `windows-x64-setup-unsigned.exe` or the matching ZIP |
| Windows ARM64 | `windows-arm64-setup-unsigned.exe` or ZIP containing native LanceDB and PyArrow wheels; requires an existing native CPython 3.13 Hermes environment |
| Linux x64 / ARM64 | Matching architecture's TAR/ZIP; run the included `install.sh` inside Linux |
| WSL2 | Linux package inside the WSL distribution, using its Linux Hermes environment |

No Intel-Mac package is supported. The installers require an existing, working
Hermes installation; they do not create Hermes or download model weights.
Windows setup executables are unsigned unless the selected release explicitly
states otherwise. Verify macOS signing/notarization from that release's receipts,
not from the filename alone. Verify the downloaded asset's SHA-256 against the
release manifest. Do not disable platform protections to force installation.

## Install or update within the requested scope

Determine the actual Hermes root, existing profile names, and the Hermes Python
interpreter; do not infer them from the current shell's Python. A named profile
and the root/default profile are different targets. Preserve existing memory,
provider credentials, models, and dimensions.

The graphical macOS assistant and guided console setup offer **all existing
profiles**, **default**, or selected names. Activation is a separate choice.
Selecting all applies to the profiles listed in the plan, not future profiles.
The PKG staging step alone has not activated any profile.

For noninteractive setup, use the extracted bundle's `installer.py` to create a
read-only plan with the actual paths, `--profile all` (or default/name), and
`--activate` when activation is requested. The root belongs in `--home`, not a
named profile's directory. Review the plan's exact targets. After backing up
affected configuration, data, and dependencies and stopping affected Hermes
processes, apply the same arguments with `--apply --confirm` and the plan hash,
plus `--runtimes-stopped`. Run as the Hermes user, not a different administrator.

The plugin transaction backs up changed files/configuration; it does not snapshot
the entire Python environment. A failed dependency preflight must be resolved in
the selected environment before retrying; do not work around it by deleting data.

## Verify actual activation

After an authorized restart of the affected Hermes instance, verify each selected
profile separately:

- PLUR1BUS is its memory provider, `memory.memory_enabled` is true, and both
  `plur1bus` and `plur1bus-controls` are enabled and not blocked by plugin lists.
- The PLUR1BUS sidebar entry/settings page loads for enabled profiles, including
  after switching profiles; browser/desktop caches are not installation evidence.
- Fresh runtime logs show the plugin loaded. `/plur1bus doctor` and the dashboard
  provide diagnostics; an empty database is not by itself an error.
- With permission to create a test memory, store and recall a benign marker in
  the intended profile, wait for asynchronous capture completion, and check that
  another profile cannot retrieve it. Use the recoverable forget flow to remove
  the marker afterward; never purge a database as a smoke test.

Report package installation, profile activation, visible UI, and successful live
capture/recall as separate observations. Do not claim all were verified from a
successful installer exit alone.

## Diagnose without altering unrelated data

For a missing settings entry, inspect the active profile's activation flags and
fresh desktop-plugin logs. Older Hermes setups may contain a stale materialized
`desktop-plugins/plur1bus` copy as well as `plugins/plur1bus/desktop`; compare both
with the installed release before blaming the provider. Prefer reapplying the
current checksum-verified installer over handwritten host patches.

For capture/recall errors, identify the actual gateway interpreter, full failing
operation, selected backend/model, and scoped database. A generic import error is
not proof that a package is absent: dependency incompatibility can produce it.
Use that interpreter's dependency check and imports before proposing a change.
Preserve retry queues and snapshot storage before schema repair or migration.

Model/provider changes and embedding-dimension conversion are separate operations,
not part of an ordinary update. Use PLUR1BUS's reviewed retrieval migration flow
with backups and its plan/prepare/stage/validate/activate steps only when requested.
Do not edit vector dimensions directly or replace live LanceDB tables manually.
