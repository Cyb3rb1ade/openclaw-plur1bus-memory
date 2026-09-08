# Graphical macOS profile setup — local candidate verification

Status: implemented and locally tested; **not published**. Existing
`7.12.7-hermes.3` release assets are unchanged. This dirty-worktree QA build uses
the existing package version only for local testing; a reviewed new release
identity, clean source, Developer ID signing, notarization, and publication gates
remain separate. It is not a replacement download for the published release.

## Change

- Apple Silicon PKG (macOS 13+) installs `PLUR1BUS einrichten.app` in Applications.
  Welcome/conclusion explicitly distinguish installing the assistant from
  configuring Hermes. No privileged profile-writing postinstall script.
- Native SwiftUI assistant, with AppKit only for folder/file selection: inspect
  existing profile activation, select all/default/individual profiles, review
  exact names and effects, confirm stopped runtimes, install and activate.
- All discovered profiles and activation are preselected; writes still require
  final confirmation. New profiles created later require setup again.
- Same portable installer transaction and confirmation fingerprint as CLI;
  paths/arguments are passed directly, never shell-expanded. The UI cannot quit
  during a running operation. No model change, migration or automatic restart.
- CLI guided defaults match the setup intent. Noninteractive defaults remain
  read-only and nonactivating. Plans warn about files-only installation and
  partial provider/plugin activation. Activated installs verify the final config.
- Retained Intel CI compatibility jobs only build portable bundles. The new
  graphical PKG is Apple Silicon only; no Intel edition is claimed.

## Measured verification

- `python -m pytest distribution/tests -q`: **169 passed** (including Coder-style
  partial activation, all-profile activation, preservation of unselected config,
  read-only secret-free inventory, confirmation and macOS packaging tests).
- Native Swift compile, `pkgbuild`, `productbuild`, and package expansion passed.
- Computer UI test on the app extracted from the PKG: six real local profiles
  detected read-only; all/default selection and review worked. Coder's missing
  activation was visible. No real profile was changed.
- Computer UI install/apply in temporary `Hermes Home` with `default` and a
  deliberately partial `coder`: success, both reported fully activated on a
  fresh profile inspection. Repeated installation also passed.
- Both installed receipts: **88 files each, zero checksum mismatches**.
- Package smoke: real wheel imports, LanceDB capture/recall with stub embeddings,
  reranker configuration and file rollback passed in a disposable environment.
  No model download or production-memory operation was used for this smoke.
- The first smoke inherited the local Hermes environment's incompatible
  `huggingface-hub==1.24.0` / Transformers combination. The passing run used an
  isolated QA venv with `huggingface-hub==0.36.2` and explicit read-only dependency
  search paths. The production environment was not repaired or changed.
- During UI QA, Python bytecode generation was found to alter the signed app
  bundle. Setup now launches Python with `-I -B`. After final real UI install,
  `codesign --verify --strict --verbose=2` passed on the extracted app. This is
  an **ad-hoc QA seal**, not Developer ID/notarization evidence.
- `git diff --check`: clean.

Final local PKG:
`/tmp/plur1bus-setup-qa.v0fVcZ/artifacts-sealed/plur1bus-7.12.7-hermes.3-macos-arm64-unsigned.pkg`

SHA-256: `fbcbd768e21237b74ce63514557ee22684b3037e3bb639938c66aad0fef1b85d`

Test home, isolated venv, and transaction receipts are retained under
`/tmp/plur1bus-setup-qa.v0fVcZ/` for inspection. No production activation,
GitHub asset, tag, npm dist-tag, or public release was modified.
