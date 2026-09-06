# PLUR1BUS for Hermes — portable distribution

This bundle installs the PLUR1BUS provider, Controls, dashboard and Desktop plugin
into an **existing Hermes installation**. It does not install Hermes itself.
No npm installation is needed for the Python Hermes provider. The OpenClaw npm
package remains a separate distribution; do not install it into Hermes.

## Choose the right artifact

| Environment | Artifact and launcher |
| --- | --- |
| macOS, Apple Silicon or Intel | Portable `.tar.gz` / `.zip`, `install.sh`; optional `.pkg` stages the same assistant in `/Applications/PLUR1BUS Installer` |
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
Neither installer changes ExecutionPolicy, disables antivirus, installs models,
changes embedding dimensions, migrates memory, restarts Hermes, or overwrites the
Hermes app. Unsigned candidates are named/documented as such; signing/notarization
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

Use `--activate` explicitly to select `memory.provider: plur1bus` and enable its
two backend plugins. Without it, existing provider selection is preserved.
Use repeated `--profile NAME`, or `--profile all` for existing profiles only.
Plugin files are profile-scoped, but pip updates the **shared Hermes venv**:
stop all processes using that venv. No new profiles are created. An older
installation receipt prevents accidental downgrades.

Default installation resolves dependencies, including the `local-onnx` extra.
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

## Updates, backups and recovery

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

Hourly/daily maintenance remains available through `plur1bus-hermes-jobs` on
each platform. The existing `plur1bus-hermes-jobs-install` helper is **macOS
launchd only**; Linux/Windows users must schedule the jobs command using their
OS scheduler. These installers deliberately do not create background services.
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
