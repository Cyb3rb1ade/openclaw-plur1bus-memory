# PLUR1BUS for Hermes — portable distribution

This bundle installs the PLUR1BUS provider, Controls, dashboard and Desktop plugin
into an **existing Hermes installation**. It does not install Hermes itself.
No npm installation is needed for the Python Hermes provider. The OpenClaw npm
package remains a separate distribution; do not install it into Hermes.

## Choose the right artifact

After installation, `plur1bus-hermes-snapshot` provides offline export/verify/
restore; see [snapshot instructions](docs/hermes-snapshot-restore.md) before use.
It preserves explicitly selected configs/artifacts and retains replaced roots.
Automatic lossless merging is separately opt-in. Obsidian note review is available
in the dashboard and with `plur1bus-hermes-operator --hermes-home HOME --agent PROFILE
obsidian plan`. No model switch or data rewrite is implied by installing a bundle.
See the included [feature checkpoint](docs/audits/hermes-completion-followup-2026-09-06.md)
for implemented native variants and remaining parity/acceptance boundaries.

| Environment | Artifact and launcher |
| --- | --- |
| macOS, Apple Silicon | Portable `.tar.gz` / `.zip`, `install.sh`; optional `.pkg` stages the same assistant in `/Applications/PLUR1BUS Installer` |
| macOS, Intel (candidate) | Same assistant, but requires a native-built LanceDB wheel and separately validated ML dependencies; not yet a certified full-stack installation |
| Linux / WSL2, x86-64 or ARM64 | Portable `.tar.gz`, run `install.sh` **inside Linux/WSL** |
| Native Windows x86-64 | Portable `.zip` + `install.ps1`, or the Windows-built console setup `.exe` |
| Windows Desktop, backend in WSL/remote | Desktop-only installation in Windows; separate backend installation inside WSL/remote |

Portable means Python source, not architecture-independent native dependencies.
The Hermes venv must have Python >=3.11 and compatible LanceDB, NumPy, PyTorch,
sentence-transformers and optional ONNX wheels for its OS/architecture. Native
Windows ARM64, Termux and other architectures are **not certified** by this build
matrix. Failed dependency resolution stops before plugin activation.

The `.pkg` is an assistant container, not a privileged postinstall that guesses
your user/profile. After installing it, open **Install PLUR1BUS.command** in that
folder and review the plan. Python comes from existing Hermes or your PATH.
The Windows `.exe` bundles its installer Python, but still uses the explicitly
selected Hermes venv for the provider. Run the assistant as your normal user.
Native candidate artifacts are platform-qualified (for example,
`plur1bus-<version>-windows-arm64-setup-unsigned.exe` and
`plur1bus-<version>-macos-x86_64-unsigned.pkg`); their accompanying native
`.zip` and `.tar.gz` use the same qualifier. Portable builds without a native
installer flag deliberately retain the unqualified bundle name.
Package installation does not change ExecutionPolicy, disable antivirus, install
models, change dimensions, migrate memory, restart Hermes or overwrite its app.
Model/memory changes are separate, explicitly approved operations described below.
Unsigned candidates are named/documented as such; signing/notarization
is a separate release gate, not implied by an artifact's existence.

## Integrity and installation

Download from the trusted GitHub release and verify `SHA256SUMS` (macOS:
`shasum -a 256 -c SHA256SUMS`; Linux: `sha256sum -c SHA256SUMS`; Windows:
`Get-FileHash -Algorithm SHA256 <artifact>` and compare the published hash).
The internal manifest validates every payload file. A checksum manifest is not
a publisher signature; do not trust an archive from an unknown source.

Running the launcher without arguments opens a guided terminal assistant. It
asks for an existing Hermes root home and profile, displays a read-only plan,
then requires typing `INSTALL` after stopping affected Hermes runtimes.
Native Windows normally uses `%LOCALAPPDATA%\hermes`; Linux/macOS/WSL use
`~/.hermes`. `HERMES_HOME` is suggested but never silently applied.
Hermes environments created by `uv` may omit `pip`. The preview uses Python's
standard-library package metadata and does not install anything. Confirmed apply
can bootstrap `pip` from that interpreter's bundled `ensurepip`, with a separate
transaction log. If neither is available, preflight asks you to provision the
selected venv using its environment manager. Configuration pipes explicitly use
UTF-8 on both ends, including Unicode profile descriptions on Windows.

For automation, run a plan first (substitute real absolute paths):

```sh
python3 installer.py --home /absolute/hermes-home \
  --python /absolute/hermes-venv/bin/python --profile default
```

Review its effects and confirmation hash, stop affected Hermes runtimes, then
repeat the **same arguments** with:

```sh
--apply --confirm HASH_FROM_PLAN --runtimes-stopped
```

### Additional native Windows ARM desktop launcher

This is an optional, separate launcher for an already prepared native ARM64
Hermes tree; it never replaces the normal Hermes shortcut. It requires an
existing standard-GIL CPython 3.13 ARM64 virtual environment and an existing
ARM64 Desktop executable. It does not download Python, create a venv, modify
the registry, or change PATH/global environment. Review the plan binding all
four absolute paths, then repeat the same command with its confirmation:

```powershell
installer.exe --native-arm-launcher --home "$env:LOCALAPPDATA\hermes" `
  --native-root "$env:LOCALAPPDATA\hermes\hermes-agent" `
  --native-python "$env:LOCALAPPDATA\hermes\hermes-agent\venv-arm64\Scripts\python.exe" `
  --native-desktop-exe "$env:LOCALAPPDATA\hermes\hermes-agent\apps\desktop\release\win-arm64-unpacked\Hermes.exe"
```

Repeat those exact four path arguments with `--apply --confirm HASH_FROM_PLAN`.
Unlike package installation, this launcher-only operation neither writes a
profile nor touches a running Hermes process, so it has no `--runtimes-stopped`
requirement.

Confirmed apply writes only `%LOCALAPPDATA%\hermes\bin\plur1bus-native-arm-desktop.cmd`
and its receipt/backup under that same Hermes home. The launcher supplies
`HERMES_HOME`, `HERMES_DESKTOP_HERMES_ROOT`, and `HERMES_DESKTOP_PYTHON` only
to that process. Symlinks and Windows reparse points in the bound or managed
paths are refused; a foreign pre-existing launcher is not overwritten.

Use `--activate` explicitly to select `memory.provider: plur1bus` and enable its
two backend plugins. Without it, existing provider selection is preserved.
Use repeated `--profile NAME`, or `--profile all` for existing profiles only.
Plugin files are profile-scoped, but pip updates the **shared Hermes venv**:
stop all processes using that venv. No new profiles are created. An older
installation receipt prevents accidental downgrades.

Default installation resolves dependencies, including the `local-onnx` extra.
For the byte-pinned local BGE reranker, see [preparation and activation](docs/hermes-bge-onnx.md).
For a fresh Linux x86-64 or Windows x86-64 Hermes venv with no installed Torch, the
read-only plan explicitly shows a confirmed CPU-only Torch install from
PyTorch's official https://download.pytorch.org/whl/cpu index. It uses no pip
cache and constrains the later resolver to the installed CPU version, so a
CUDA/NVIDIA package cannot be selected silently. Any existing Torch version,
including a GPU build, is retained and constrained rather than replaced. This
does not apply on Windows ARM or Intel macOS, where local ONNX/remote providers
remain the supported fresh-install path.
If a release includes a reviewed native Intel LanceDB wheel, the plan lists it
under `nativeWheels`; only a macOS x86_64 target interpreter with dependency
installation enabled selects it. Apple Silicon, Windows, Linux and desktop-only
installs never install that wheel. It is covered by the bundle checksum manifest.
The native database wheel alone does not certify Intel compatibility of the
rest of the ML stack. Do not downgrade PyTorch to bypass a failed preflight.
Reviewed Windows ARM storage bundles list **both** LanceDB 0.34.0 and PyArrow
25.0.1 under `nativeWheels`. The current Arrow artifact requires native CPython
3.13 with the standard GIL ABI; incompatible interpreters are refused during the
read-only plan. Windows x64 and desktop-only installs never select ARM wheels.
The builder requires an explicitly approved SHA-256 for each wheel, exact pinned
wheel metadata, and ARM64 PE headers for every bundled native binary. This is a
storage packaging capability, **not yet a complete ARM edition**: native ML
dependency/provider provisioning and full installed-application acceptance must
also pass. The installer does not silently replace Hermes's x64 Python with ARM.
The Python package uses NumPy 2.3.0 on native Windows ARM and retains 2.2.0 on
other platforms. Windows ARM and Intel macOS do not implicitly install the
PyTorch-based transformer extra; configure the explicit local ONNX provider or a
supported remote provider there. Existing transformer packages/configurations
are not removed or rewritten. `local-transformers` remains an explicit extra
for operators who provision a compatible native stack; no old torch version is
selected as a compatibility workaround.
`--no-deps` is for an already provisioned, compatible venv; wheels are still
installed and checked. New pip conflicts abort before plugin-file changes.
Pre-existing conflict lines are recorded, not presented as a healthy environment.
The venv must match the installer's OS. Never point Windows pip at a WSL backend
or use a global interpreter. On Windows use `venv\Scripts\python.exe`.

For a separate WSL/remote backend, select `--desktop-only` in Windows. This only
copies the frontend into selected Desktop profile directories; it does not
call pip, change backend config, or activate a provider. Install and activate
the backend separately inside its own environment. The startup handshake still
requires the selected backend to report the correct agent/profile identity.

## Model changes and memory migration

After installing the package, the same assistant offers **model/memory change**.
Choose one existing profile and supply an explicit JSON target (`embedding` or
`reranker`). No model is chosen on your behalf and no old vectors are reused in
a different model space, even when the dimensions happen to be equal.

For automation, save the chosen model's supported config as JSON, for example
`{"provider":"local-transformers","model":"YOUR_MODEL_ID","dimensions":768}`.
Choose the actual model/dimensions intentionally; this is not a recommendation.
For remote providers use `baseUrl` and an `apiKeyEnv` name, never an inline key.
Applicable model license acknowledgement must be present in the target config.

```sh
python3 installer.py --home /absolute/hermes-home --python /absolute/venv/bin/python \
  --profile PROFILE --retrieval-kind embedding --retrieval-target /absolute/target.json
```

This prints the source partition, record count, target model and confirmation hash
without downloading a model. Stop affected runtimes, then repeat with
`--retrieval-action stage --apply --confirm HASH --runtimes-stopped`.
If model files are not prepared yet, first use `--retrieval-action prepare`
with the same approval flags. This prepares the supported pinned Jina Nano ONNX
artifacts (with license acknowledgement), or probes/downloads the chosen local
Transformer model. Remote targets receive synthetic probe text only at this
step. Preparation does not change the active model or memory store.
Staging first snapshots the database, then re-embeds into a separate, resumable
generation and validates all non-vector record fields. Source vectors, IDs, ACLs,
timestamps and original memories remain intact. **Remote re-embedding transmits
memory text to the chosen provider and may incur API costs.**

Repeat with `--retrieval-action validate` for a read-only staging check. Finally
use `--retrieval-action activate --apply --confirm HASH --runtimes-stopped` to
switch the generation pointer. Activation revalidates the source and requires a
matching, readable backup. Source/config changes invalidate approval; obtain a
new plan. Restart Hermes afterward. Staging alone never switches models.
Interrupted staging can be retried while its pinned source remains unchanged.

For rerankers, use `--retrieval-kind reranker`: after review go directly to
`activate`. The target must pass a finite-score smoke test (or explicitly be
`disabled`); no re-embedding is needed. An empty new embedding store also uses
`activate`, with a real model/dimension probe and backed-up config write.
Named profiles receive their own override, not a write into the root profile.
Bulk `all` and custom namespace cutovers are refused; review each private writer.
Profiles intentionally aliased to the same agent/data root share its generation;
a model switch applies to that store, not a separate copy per alias.

Package rollback does not undo a generation change. Source databases,
`state/<agent>/retrieval-backups/`, config backups and generation journals are
retained. An interrupted pointer activation uses the existing
`plur1bus-hermes-operator ... reembed --recover` workflow with its saved staged
plan and exact approved plan ID. Never discard generations or return to an old
source after new captures without a fresh migration/reconciliation plan.

Legacy OpenClaw-to-Hermes import remains available through the bundled
`plur1bus-hermes-migrate` CLI, with explicit source, target, snapshot and agent
mapping. Model changes do not implicitly import or merge another agent's store.

## Package updates, backups and recovery

All file replacements have a checksum-verified backup and journal under
`<Hermes-Home>/plur1bus-install-backups/<transaction>`. Unknown files (including
provider/model config) and memory data are preserved. Obsolete files from an
earlier installer receipt are moved into the backup, not recursively deleted.
After success, restart affected Hermes instances and check provider, capture,
recall and the dashboard in each selected profile.

Read-only rollback plan:

```sh
python3 installer.py --home /absolute/hermes-home --rollback TRANSACTION_NAME
```

After reviewing it, repeat with `--apply --confirm HASH --runtimes-stopped`.
New user edits block automatic rollback. Newly installed files are moved into
the backup's `removed` directory. **File rollback does not roll back pip.**
The transaction includes pip-before, pip-check-before/after and pip.log for
environment recovery. Do not restart after a failed pip phase until dependencies
are healthy; consult the journal or restore your pre-install venv snapshot.
A stale `.plur1bus-install-lock` is never stolen: inspect the transaction and
ensure no installer is running before manually removing that empty lock directory.

## Desktop host compatibility and maintenance

The PLUR1BUS Desktop startup check is read-only. It verifies routing/profile
identity and reports missing capabilities; it cannot retrofit a sidebar API
into an incompatible Hermes binary. `helpers/plur1bus-desktop-host.py` and the
adjacent patch directory can prepare a **separate** compatible host build from
a trusted clean Hermes source checkout (Python >=3.12 and its Node/npm toolchain
required). Run with `--source /absolute/source` to review a plan first. The
helper never replaces your app or auto-publishes; read the provider README for
the complete host-build procedure. No binary host patch runs at every startup.

Hourly/daily maintenance is available through `plur1bus-hermes-jobs` on each
platform. `plur1bus-hermes-jobs-install` now previews native **per-user** schedules:
launchd on macOS, systemd user timers on Linux/WSL, Task Scheduler on Windows.
It never installs an elevated service. The package installer does not implicitly
register jobs. Use the same Hermes venv and an **effective PLUR1BUS JSON config**
(not the outer Hermes YAML). Example, preview first:

```sh
plur1bus-hermes-jobs-install --data-dir /absolute/data --config /absolute/plur1bus.json --agent main --agent bernhardine
```

After reviewing, repeat with `--apply` to write definitions, and additionally
`--load` to register them. `--backend launchd|systemd|windows` supports cross-OS
definition previews; loading requires the matching OS. Linux/WSL needs a running
user systemd manager; absent managers fail before definitions are written.
Windows tasks run only while their registering user is logged in, without
credentials/elevation. macOS jobs require a GUI login session. No catch-up run
is requested for missed schedules. Native Windows/WSL scheduler execution still
needs acceptance on those hosts; generated XML alone is not that evidence.

Job identities bind the data root, config path, agent and mode. Existing changed
definition files and existing Windows registrations are not overwritten.
Loading an already loaded launchd job also fails visibly. Review/remove old
registrations before changing definitions. **When upgrading from the old macOS
helper**, unload its `com.plur1bus.hermes.<agent>.<mode>` jobs before registering
the new root/config-bound labels to avoid duplicate timers. Stop old maintenance
processes before upgrading: a nonempty legacy PID lock is deliberately reported
as `legacy-maintenance-lock-needs-review`, not stolen. Only after verifying all
old jobs are stopped may that exact old lock be removed. New OS lock files remain
empty and must not be unlinked; process exit automatically releases ownership.

MLX/oMLX remains an optional Apple-specific backend, not a dependency for other
platforms. Local model files are downloaded on use, not shipped in the archive.
Windows uses OS-owned byte-range locks and native file flush/write-through
publication, not a fake no-op lock. Filesystem power-loss guarantees differ from
POSIX; use a private local filesystem, not shared/network memory directories.

## Build and release gates (maintainers)

Build from a reviewed checkout with new source files tracked, Python >=3.11,
setuptools and wheel:

```sh
python distribution/build.py --output /new/empty/artifact-directory
# On macOS, additionally: --mac-pkg
# On Windows with PyInstaller installed, additionally: --windows-exe
```

`distribution.json` records source commit, dirty state, versions and file hashes.
A dirty candidate must not be advertised as a commit-reproducible release.
The Windows executable must be built on Windows. The CI workflow builds native
artifacts and tests installer transactions, actual wheel installation, storage,
shared/exclusive process leases and recovery in temporary homes. CI artifacts
are **not** automatically published. Release requires green platform runs,
signed/notarized installers if advertised as signed, matching outer checksums,
and an explicit publication decision. Never overwrite an existing release asset.
