# Distribution and installation (HM1)

How the PLUR1BUS memory plugin (`@cyb3rb1ade/plur1bus-memory`, plugin id
`memory-lancedb-namespaced`) reaches an OpenClaw host: the one-line installers,
what they do, every flag and exit code, the signed feed, update, rollback,
uninstall, adoption of an rsync deploy, the licence gate and the selftest.
Every command and flag below matches the installer's `--help`
(`plur1bus-plugin-installer.mjs --help`, source `scripts/dist/installer/main.mjs`).

Release owners: the per-release steps are in
[`release-checklist.md`](release-checklist.md#distribution-hm1).
The OpenClaw behaviour the installer relies on is recorded in
[`distribution/openclaw-cli-facts.md`](distribution/openclaw-cli-facts.md).

## Contents

1. [Targets](#targets)
2. [The one-liners](#the-one-liners)
3. [What the installer does](#what-the-installer-does)
4. [Flags](#flags)
5. [Exit codes](#exit-codes)
6. [Environment variables](#environment-variables)
7. [The feed and its signature](#the-feed-and-its-signature)
8. [Update, rollback and resume](#update-rollback-and-resume)
9. [Uninstall and purge](#uninstall-and-purge)
10. [Adopting an rsync deploy (legacy)](#adopting-an-rsync-deploy-legacy)
11. [The licence gate](#the-licence-gate)
12. [The selftest](#the-selftest)
13. [Privacy: what is read, written and snapshotted](#privacy-what-is-read-written-and-snapshotted)

## Targets

Five targets only. Anything else (musl/Alpine, darwin-x64, 32-bit, glibc older
than 2.27) is refused with exit 3 `unsupported-target` before any change.

| Target | Host | Script |
|---|---|---|
| `linux-x64`, `linux-arm64` (glibc >= 2.27) | native | `install-plugin.sh` |
| `darwin-arm64` | native | `install-plugin.sh` |
| `win-x64`, `win-arm64` | native, **beta** | `install-plugin.ps1` |
| Windows with WSL2 | Linux inside the distro | `install-plugin.ps1 -Target wsl:<distro>` delegates to `install-plugin.sh` in that distro |

Host: OpenClaw only. `--host hermes` exits 3 `host-not-yet-supported`
(Hermes host mode arrives with HM2); nothing is changed.

Windows native support prints "Windows native support is in beta" while the
signed feed carries `hosts.openclaw.windowsNativeBeta: true`. The owner clears
that flag by re-signing the feed; no client release is needed.

Requirements the installer checks: OpenClaw `2026.8.1` or newer (the tarball's
`openclaw.compat.minGatewayVersion`, re-checked by OpenClaw itself), the Node
that OpenClaw runs on within `>=24.16.0 <25 || >=26.1.0`, and about 1.5 GiB
free under the state directory (the plugin's dependency tree plus one
embedding model).

## The one-liners

Linux and macOS:

```sh
curl -fsSL https://plur1bus.app/install-plugin.sh | sh -s -- [installer flags]
```

Windows (Windows PowerShell 5.1 or PowerShell 7, no administrator rights):

```powershell
& ([scriptblock]::Create((irm https://plur1bus.app/install-plugin.ps1))) [-Target native|wsl:<distro>] [-ProbeWsl] [installer flags]
```

The `.ps1` looks for OpenClaw natively (`openclaw.cmd` / `openclaw` on `PATH`)
and inside the WSL distros (`wsl.exe -l -q`; running ones from
`wsl.exe -l -q --running`, so detection does not depend on the language of
Windows). A running distro is probed for `openclaw` directly; a **stopped**
distro is started for the probe only with `-ProbeWsl` or an interactive yes.
Several candidates and no `-Target`: an interactive choice, or exit 2 listing
them. `-Target wsl:<distro>` pipes the feed's `bootstrap.sh` (checked against
its SHA-256 from the signed feed) into the distro with the resolved version,
and the distro's own run verifies the feed again; `--offline <path>` is
translated with `wslpath -a`.

The bootstraps are thin. Each one:

1. finds `openclaw`, and a Node within the plugin's engines range (`node` on
   `PATH`, else the Node OpenClaw's own wrapper runs on);
2. downloads `{channel}.json` and `{channel}.json.minisig` into a private temp
   dir and **verifies the signature first**, with the minisign verifier
   (`scripts/dist/minisign.mjs`) inlined at release time and run by that Node;
3. downloads the bundled installer that the feed names and checks its SHA-256;
4. runs `node plur1bus-plugin-installer.mjs --feed-file <verified feed> [flags]`
   **as a child process** (it does not `exec` into it), gives it the terminal
   for its questions when there is one, removes the temp dir on exit, and
   returns the installer's exit code.

Bootstrap-only exit codes: 1 for a bad or missing signature, a checksum
mismatch, a channel mismatch or a download failure (nothing downloaded beyond
the feed, nothing changed), 3 for `openclaw-not-found`, `node-not-found` and
`unsupported-target`, 2 for several Windows candidates without `-Target`.
Neither script uses `sudo` or writes outside its temp dir; the `.ps1` is
unsigned (Authenticode pending) and the bootstraps are hosted at
`https://plur1bus.app/` beside the harness installers.

Details worth knowing: the installer's SHA-256 check happens after its
download but before it runs, so a mismatch runs nothing; without `curl` and
`wget` the shell script exits 3; the WSL delegation of the `.ps1` needs a Node
(`node.exe`) on the Windows side, because the feed signature is verified there
before anything is handed to the distro.

Channel: `PLUR1BUS_PLUGIN_CHANNEL=beta` selects `beta.json` and the beta key;
the default is `stable`.

## What the installer does

`install` (a fresh install), in this order. Any failure after the first change
rolls back and exits 1 (4 if the rollback itself fails).

1. **Feed.** Loads the feed. With `--feed-file` (what the bootstraps pass) the
   signature was verified by the bootstrap; run directly, the installer
   verifies `<feed>.minisig` with the channel key rendered into the release
   bundle. Picks the release (`--version`, default the feed's `latest`).
2. **Source.** Default: `clawhub:@cyb3rb1ade/plur1bus-memory@<v>` when the
   feed release carries `clawpackDigest`; **otherwise the feed's GitHub Release
   tarball**, downloaded by the installer, capped at 200 MB and installed only
   after its SHA-256 matched the signed feed (`npm-pack:<file> --force
   --accept-capabilities`). `--source clawhub` without a digest refuses
   (exit 3 `clawpack-digest-missing`) instead of installing something that
   cannot be verified. `--source npm` uses `npm:@cyb3rb1ade/plur1bus-memory@<v>
   --pin`. `--offline <tgz>` verifies a local tarball against the feed and
   installs it like the tarball source.
3. **Detect.** `openclaw --version` on `PATH`, the Node OpenClaw runs on, and
   the state directory exactly as OpenClaw resolves it: `OPENCLAW_STATE_DIR`,
   else `<home>/.openclaw-<profile>` for `OPENCLAW_PROFILE`, else
   `<home>/.openclaw`, else a legacy `<home>/.clawdbot` when only that exists;
   `<home>` is `OPENCLAW_HOME`, `HOME`, `USERPROFILE`. `--state-dir` and
   `--profile` set the matching environment variables for OpenClaw. Paths with
   spaces and non-ASCII characters are supported.
4. **Compatibility**, read-only. Every fatal finding is printed together and
   the run exits 3 with nothing changed: `unsupported-target`,
   `openclaw-too-old`, `node-unsupported`, `insufficient-disk`,
   `config-readonly` (`OPENCLAW_CONFIG_READONLY=1` or `OPENCLAW_NIX_MODE=1`;
   the installer checks these itself, OpenClaw 2026.8.1 does not),
   `config-invalid` (`openclaw config validate` failed: run
   `openclaw doctor --fix`), `store-inside-harness-home` (the configured store
   lies inside a PLUR1BUS harness home; one engine per store). A harness home
   elsewhere only prints a notice.
5. **Interrupted run?** A state file with an unfinished operation is handled
   first, see [resume](#update-rollback-and-resume).
6. **Existing install?** Detected through `openclaw plugins inspect
   memory-lancedb-namespaced --json` (the install record), never by parsing the
   install message. A tracked install switches to the update path. A directory
   at `<state>/extensions/memory-lancedb-namespaced` without an install record
   is an rsync deploy: exit 2 `legacy-deploy`, naming `--adopt-legacy`.
   `install` never overwrites an existing install.
7. **Licence gate**, before any change, see [below](#the-licence-gate).
8. **Install.** `openclaw plugins install <locator> [--pin | --force
   --accept-capabilities]`. Tarball and offline sources are installed from a
   verified copy kept at `<stateDir>/plur1bus-installer/artefacts/<version>.tgz`
   (the current and the previous version are kept, older ones deleted), so the
   path OpenClaw records outlives the run and a rollback or `--offline` update
   can find it.
9. **Config**, only through `openclaw config set` and only these keys:
   `plugins.slots.memory` (set to the plugin; the previous value is kept in the
   installer state and restored on uninstall if it was not `memory-core`),
   `plugins.entries.memory-lancedb-namespaced.config.modelPreparation.profile`
   and `.acceptNonCommercialLicense`, `.embedding.provider` (`local-transformers`)
   and `.embedding.model` (only when no embedding provider is configured; an
   existing choice is never changed), and
   `plugins.entries.memory-lancedb-namespaced.hooks.allowConversationAccess`.
   The last one is set to `true` on a **fresh install and an adoption only**;
   the summary calls it "conversation access for capture and recall", because
   the plugin cannot capture or recall without it. An update never sets it, and
   a value a person set to `false` stays `false`. If OpenClaw recorded the
   plugin disabled (its config was absent), the installer enables it.
10. **Feature crons.** Only with a Gateway that `openclaw gateway status --json`
    confirms as running: `node <pluginDir>/scripts/setup-feature-crons.mjs
    --json` (the step `--ignore-scripts` skipped); warnings are reported, never
    fatal. Otherwise the step is skipped and the plugin provisions its jobs on
    the next Gateway start.
11. **Verify.** (a) `plugins inspect --runtime --json`: status `loaded`,
    `imported`, no `sdk-incompatible` diagnostic. (b) Integrity: the install
    record's version equals the release; a ClawHub install's
    `clawpackSha256` equals the feed's `clawpackDigest`, any other source's npm
    integrity equals the feed's tarball integrity. (c) `openclaw plur1bus
    selftest --json` ([below](#the-selftest)). (d) The embedding model: present
    or downloaded is ok; missing is a warning (it downloads on first use, or
    pass `--download-models`).
12. **Rollback on failure.** Restores the previous values of the config keys it
    wrote (keys that had no previous value stay set and are listed, there is no
    `config unset` route), runs `openclaw plugins uninstall
    memory-lancedb-namespaced --force`, restores the previous memory slot. If
    that fails the report prints the exact commands to run and the exit code
    is 4.

With `--dry-run` the run stops after the checks and prints the plan (`plan`
lines); it changes nothing. With `--json` one `plur1bus.plugin-installer/1`
document goes to stdout and the human lines to stderr.

Restart the Gateway afterwards (`openclaw gateway restart`); with a running
Gateway, OpenClaw applies the install live.

## Flags

| Flag | Meaning |
|---|---|
| `--host openclaw\|hermes` | Host to install into. Default `openclaw`; `hermes` exits 3. |
| `--version <v>` | Plugin version. Default: the feed's `latest`. |
| `--source clawhub\|npm` | Install source, see step 2. |
| `--offline <tgz>` | Install a local tarball after its SHA-256 matched the feed. |
| `--feed <url>` | Signed plugin feed. Default `https://updates.plur1bus.app/plugin/stable.json`. Works only when you run the installer bundle directly; the bootstraps always pass `--feed-file`, so through the one-liner use `PLUR1BUS_PLUGIN_FEED`. |
| `--feed-file <path>` | A feed the bootstrap already verified. Exclusive with `--feed`. |
| `--accept-nc-licence` | Accept CC BY-NC 4.0 for Jina v5 Text Nano ([licence gate](#the-licence-gate)). |
| `--non-interactive` | Never prompt; the licence defaults to E5-small. |
| `--download-models` | Let the selftest download the embedding model. |
| `--update` | Update a tracked install (snapshot first, automatic rollback). |
| `--uninstall [--purge]` | Uninstall; `--purge` also deletes the store, the snapshots and the model cache. |
| `--yes-delete-memories` | With `--purge`: confirm the deletion without the two prompts. |
| `--adopt-legacy` | Adopt a deploy OpenClaw does not track (rsync install). |
| `--rollback` | Undo an interrupted update or adoption instead of finishing it. |
| `--yes` | Assume yes where a confirmation is optional (update: Now). |
| `--dry-run` | Check and print the plan, change nothing. |
| `--json` | One `plur1bus.plugin-installer/1` document on stdout. |
| `--state-dir <dir>` | OpenClaw state dir (sets `OPENCLAW_STATE_DIR` for OpenClaw). |
| `--profile <name>` | OpenClaw profile (sets `OPENCLAW_PROFILE` for OpenClaw). |
| `--lang de\|en` | Release-notes language. Default from `LANG`, else `en`. |
| `-h`, `--help` | Usage. |

`--update`, `--uninstall` and `--adopt-legacy` are mutually exclusive; `--purge`
needs `--uninstall`; `--yes-delete-memories` needs `--purge`. `-Target` and
`-ProbeWsl` belong to the `.ps1` bootstrap only.

## Exit codes

Identical for the bootstraps and the installer.

| Code | Meaning |
|---|---|
| 0 | Done (or a dry run that found nothing wrong). |
| 1 | Failed and rolled back, or nothing changed. |
| 2 | A choice is needed: several WSL candidates, a legacy deploy, an interrupted run that this mode may not continue, or a prompt without a terminal. |
| 3 | Incompatible host or environment (the findings above, `openclaw-not-found`, `node-not-found`, `unsupported-target`, `legacy-deploy-guard`, `unsafe-purge-path`, `clawpack-digest-missing`, `host-not-yet-supported`). Nothing was changed. |
| 4 | Verification failed **and** the rollback failed, or the Gateway blocked a store restore without a terminal to ask. The report prints the manual steps. |

## Environment variables

| Variable | Effect |
|---|---|
| `PLUR1BUS_PLUGIN_CHANNEL` | Bootstraps: release channel `^[a-z0-9-]+$`, default `stable`. |
| `PLUR1BUS_PLUGIN_FEED` | Bootstraps: feed URL, `{channel}` is replaced, **https only**. A supported mirror override that needs no test flag, because the feed signature is still verified with the key built into the script. The `.ps1` forwards it into a WSL distro. The installer bundle run directly ignores it unless the test flag is set; use `--feed` there. |
| `PLUR1BUS_ACCEPT_NONCOMMERCIAL_LICENSE=1` | Same as `--accept-nc-licence`. |
| `OPENCLAW_STATE_DIR`, `OPENCLAW_PROFILE`, `OPENCLAW_HOME`, `OPENCLAW_CONFIG_READONLY`, `OPENCLAW_NIX_MODE` | OpenClaw's own, honoured as OpenClaw honours them. |

**Test seams**, honoured only with `PLUR1BUS_PLUGIN_INSTALLER_TEST=1` and
ignored otherwise. They exist for the test suites and `plugin-dist.yml` and
are not a supported way to install:

| Seam | Effect |
|---|---|
| `PLUR1BUS_PLUGIN_INSTALLER_TEST` | Enables the seams below and permits `file://` feeds and downloads. |
| `PLUR1BUS_PLUGIN_FEED` (installer run directly, `file://`) | Feed location. |
| `PLUR1BUS_PLUGIN_PUBKEY` | A `TEST ONLY` minisign public key used instead of the channel keys. |
| `PLUR1BUS_PLUGIN_WSL_EXE` | Path of a `wsl.exe` shim (`.ps1`). |
| `PLUR1BUS_PLUGIN_TEST_FREE_BYTES` | A fixed free-space figure for the disk check. |
| `PLUR1BUS_SELFTEST_FORCE_FAIL=1` | Makes the selftest check of a new version fail after the real selftest ran, so CI can drive a real rollback. A rollback's own verify is never forced. |

## The feed and its signature

`https://updates.plur1bus.app/plugin/{channel}.json` (`stable`, `beta`), schema
`plur1bus.plugin-feed/1` (`scripts/dist/plugin-feed.schema.json`), with the
detached minisign signature at `{channel}.json.minisig`. It holds the installer
bundle and both bootstraps (URL and SHA-256), and per OpenClaw release: version,
`clawhub` and optional `npm` locator, the tarball (URL, SHA-256, npm sha512
integrity), the optional `clawpackDigest`, `openclaw.compat`, `engines.node`, a
`security` flag and release notes in German and English. `hosts.hermes` is
reserved and refused.

**Who signs.** The owner, **offline**, with the channel's secret key
(`minisign -S -s <channel>.key -m <channel>.json`), the same key and procedure
as the harness `release.json` (harness `docs/manual-release.md`). CI never holds
a secret key; the release workflow produces the unsigned feed. Promoting
`beta` to `stable` re-signs identical bytes.

**Where the keys come from.** The channel public keys are plugin repository
variables, equal to the harness ones, rendered into both bootstraps and into
the installer bundle at release, before the feed hashes the bundle. An
installer build with an unrendered placeholder, or a dry-run `TEST ONLY`
render, refuses every feed it would have to verify itself (`--feed`) and runs
only with a bootstrap-verified `--feed-file`; a real release run fails if a
placeholder survives or any of the three files carries the `TEST ONLY` render.

**Comparison with the harness one-liner (HB19).** The harness one-liner cannot
verify minisign and relies on HTTPS plus SHA-256. The plugin bootstraps are
stronger: they verify the feed signature with Node **before** trusting any URL
or hash in it. A missing, malformed or wrong signature exits 1 with nothing
downloaded. Every later download (installer, tarball) is checked against a
SHA-256 in the signed feed.

## Update, rollback and resume

```sh
curl -fsSL https://plur1bus.app/install-plugin.sh | sh -s -- --update
```

A tracked install (or `--update`) takes this path:

1. Reads the installed version from the install record. Equal to the target:
   `up-to-date`. Newer than the feed's: nothing to do.
2. Prints the release notes of every version after the installed one up to the
   target, in `--lang`, with security fixes marked, then asks **Now / Later /
   Skip** on a terminal. `--yes` means Now; without a terminal and without
   `--yes` it exits 2. Later and Skip change nothing and record nothing (nothing is remembered between runs); there
   is no skip list.
3. Before any change: the rollback artefact for the installed version and, for
   the tarball source, the target tarball are fetched and verified against the
   signed feed. If the installed version cannot be reinstalled later
   (`no-rollback-artefact`) the update refuses.
4. Writes the installer state (`inProgress`), then takes a **snapshot** of the
   store, `pre-<target>` (no store yet: the step is skipped).
5. `openclaw plugins install <same-source locator>@<target> --force
   --accept-capabilities`. OpenClaw's `plugins update` rejects `npm:` and
   `clawhub:` locators, so an exact-version upgrade is a forced reinstall; the
   plugin's config and the memory slot survive it. An update never writes
   config. The plugin directory is read from the install record; old npm
   generation folders are never deleted, only reported with their size.
6. Verifies as above. Failure: reinstalls the previous exact version,
   **restores the snapshot**, verifies that, and only then deletes the
   `.pre-restore-*` copy of the failed store; exit 1 (4 with manual commands if
   this fails).
7. Success: records the version, keeps the current and previous tarball, and
   tells you to restart the Gateway. If `allowConversationAccess` is still
   unset, the summary names it and prints `openclaw config set
   plugins.entries.memory-lancedb-namespaced.hooks.allowConversationAccess
   true`; an update never sets it itself.

Source on update: the recorded source is reused (`--source` overrides). A
ClawHub install whose target release has no `clawpackDigest` in the feed moves
to the verified GitHub Release tarball for that update, because a ClawHub
install could not be verified.

`--update --dry-run` (and `--dry-run` on a tracked install) prints the release
notes and the plan and exits 0 without `--yes` and without a terminal; it
changes nothing.

**Snapshots** live at `<stateDir>/memory/.snapshots/plur1bus-<UTC
yyyymmddTHHMMSSZ>-<label>/` with a SHA-256 manifest (`snapshot.json`, schema
`plur1bus.snapshot/1`). They hold the resolved store (the configured
`baseDbPath`, else `~/.openclaw/memory/lancedb-namespaced` regardless of
`OPENCLAW_STATE_DIR` or profile), `memory/_archive`, `memory/run-state.json`
and `memory/merge-proposals.jsonl` when present. Not the Obsidian vault, never
config or credentials. Files are copied, never hard-linked (OpenClaw rejects
hard-linked plugin files). A LanceDB table that a running Gateway compacts
during the copy is copied again, three tries, then `source-busy`; free space of
1.1 times the copy is required (`insufficient-disk`). A store path that is a symlink resolving outside its own parent directory is refused (`unsafe-path`) rather than followed; move the store or point `baseDbPath` at the real location. The **newest five** Node
snapshots are kept and older ones pruned; the bash tool's `*.tar.gz` snapshots
are listed as legacy and never pruned or restored by the installer.
A manual tool exists in a source checkout: `node scripts/snapshot-store.mjs
<create|list|verify|restore|prune> --state-dir <d> [--base-db-path <p>]
[--label <l>] [--id <id>] [--json]`.

**The store is never restored under a running Gateway.** Before an automatic
restore the installer asks `openclaw gateway status --json`. Running (or
anything ambiguous, a timeout, a non-zero exit, unparseable output: it fails
closed): on a terminal it asks you to stop the Gateway and checks again;
without a terminal it exits 4 with the manual steps (stop the Gateway, then
`--rollback`). The plugin reinstall part of a rollback may still proceed. Only
an explicit "unreachable" answer from a Gateway that exited 0, or a free port
with connection refused, counts as stopped.

**Resume.** Every step writes `<stateDir>/memory/.plur1bus-installer.json`
first. If a run was killed, lost its network or was interrupted with Ctrl-C,
the next run reports the interrupted operation and step and continues it (a
fresh install is rolled back and repeated), or with `--rollback` undoes it
(reinstalls the previous version and restores the snapshot, again only while
the Gateway is stopped). A resume never runs a destructive step in another
mode: an interrupted purge continues only under `--uninstall --purge` with the
confirmations asked again; any other mode reports the interrupted operation and
exits 2. `--dry-run` never resumes: it names the interrupted operation and what
continuing or `--rollback` would do, and exits 0. A rollback that was itself
interrupted is retried by `--rollback`. No `*.tmp-*` file or half-restored
store is left behind.

## Uninstall and purge

```sh
curl -fsSL https://plur1bus.app/install-plugin.sh | sh -s -- --uninstall
```

Runs `openclaw plugins uninstall memory-lancedb-namespaced --force` (OpenClaw
resets a memory slot the plugin owned to `memory-core`), then restores the slot
the installer found before its first install if that was not `memory-core`.
The store, the snapshots, the model cache and the vault are **kept**.

`--uninstall --purge` additionally deletes the store, the Node snapshots
(`<stateDir>/memory/.snapshots/plur1bus-*`, never the legacy `*.tar.gz`), the
`.pre-restore-*` copies beside the store and the plugin's model cache
(`${OPENCLAW_HOME}/models/plur1bus`, where the plugin resolves it, `~/.openclaw/models/plur1bus` by default; a `models` folder under `OPENCLAW_STATE_DIR` is not touched; a custom `embedding.local.cacheDir` is not purged either, because the installer does not read that key — delete it by hand if you set one). It lists exactly what it will delete, then asks
twice (type `delete`, then `y`), or takes `--yes-delete-memories`. Without a
terminal and without that flag it exits 2 before any change. It refuses to
delete a filesystem root, a home directory, the state directory or an ancestor
of either (`unsafe-purge-path`, exit 3). The exact deletion rules of the whole installer:
the store is deleted only by `--uninstall --purge`; snapshots are pruned to the
newest five Node snapshots after a new one is taken (legacy tarballs never) and
all of them go with `--purge`; the `.pre-restore-*` copy of a failed store is
deleted only after a verified rollback; installed-tarball artefacts are pruned
to the current and the previous version; the legacy `.plur1bus-legacy-<ts>`
directory of an adoption is never deleted by the installer.

A bare `--uninstall` on an rsync deploy that OpenClaw does not track exits 2
`legacy-deploy` and changes nothing: adopt it first (`--adopt-legacy`) or
remove it by hand.

## Adopting an rsync deploy (legacy)

A plugin deployed by `install-memory-system.sh` (rsync into
`<state>/extensions/memory-lancedb-namespaced`) is not tracked by OpenClaw.
`install` and `--update` refuse it with exit 2 `legacy-deploy`; adoption is
explicit:

```sh
curl -fsSL https://plur1bus.app/install-plugin.sh | sh -s -- --adopt-legacy
```

Adoption: snapshot, rename the legacy directory to
`<state>/extensions/.plur1bus-legacy-<timestamp>` (kept, never deleted; the
dot name keeps it out of OpenClaw's plugin scan), `openclaw plugins install
<source> --force --accept-capabilities`, `allowConversationAccess` and the
memory slot, verify. On any failure it uninstalls the tracked copy, renames the
legacy directory back, restores the snapshot and the config values. The
embedding choice the deploy ran with is never changed, `memory-lancedb-stock`
and `plur1bus-release` are left alone, and an interrupted adoption is continued
or (`--rollback`) undone by the next run.

**The deploy guard.** `protect-plur1bus-deploy.sh` (run from cron every 15
minutes) restores the deploy directory from `<state>/plur1bus-release` whenever
it differs, and **may** silently revert an adoption (the live copy on a server
can differ from the repository mirror, so treat it as active). Detection is
limited: the file `<state>/scripts/protect-plur1bus-deploy.sh` exists, or a
non-comment line of the **invoking user's** `crontab -l` mentions
`protect-plur1bus-deploy` (the matched line is never printed). `/etc/cron.d`,
other users' crontabs and systemd timers are **not** detected. Run the installer
as the user that owns the state directory and the crontab. With a guard found,
`--adopt-legacy` exits 3 `legacy-deploy-guard`, changing nothing. The installer
never edits your crontab. Steps for the owner's VPS (check `/etc/cron.d` and
systemd timers by hand too):

1. Run `crontab -e` and comment out or delete the line that runs
   `protect-plur1bus-deploy.sh`. **Do this first.**
2. Move `<state>/scripts/protect-plur1bus-deploy.sh` out of the way (for
   example to `protect-plur1bus-deploy.sh.disabled`) and make sure no other
   copy remains under `<state>/scripts/`.
3. Re-run with `--adopt-legacy` (add `--dry-run` first to see the plan).
4. Do not re-enable the guard afterwards: it would restore the untracked copy.
   A rolled-back adoption leaves the guard disabled; re-enable it only if you
   go back to the rsync deploy for good. Delete `.plur1bus-legacy-<timestamp>` yourself once the adopted plugin runs
   well; `plur1bus-release` is no longer needed by the plugin.

## The licence gate

The recommended local model, Jina v5 Text Nano, is licensed CC BY-NC 4.0
(non-commercial). It is never accepted silently.

- Interactive: "Is this installation for personal, non-commercial use?" A yes
  leads to an explicit "Accept this licence?"; anything else gives E5-small
  (MIT, `e5-multilingual-384`).
- Non-interactive (`--non-interactive`, no terminal): E5-small, unless
  `--accept-nc-licence` or `PLUR1BUS_ACCEPT_NONCOMMERCIAL_LICENSE=1` is given.
- An acceptance is recorded in the installer state and the report with who (OS
  user), when, model, revision and licence.
- An existing embedding choice wins: the gate is skipped and nothing is
  written. An install without an acceptance writes
  `acceptNonCommercialLicense: false` explicitly.

## The selftest

`openclaw plur1bus selftest [--json] [--download-models] [--remote] [--keep]
[--state-dir <dir>]` runs in the CLI process without a Gateway, and the
installer runs it as its verify step. It:

1. imports each native addon (`@lancedb/lancedb`, `onnxruntime-node`, `sharp`);
2. refuses a configured store inside a PLUR1BUS harness home;
3. checks the embedding model in the plugin's cache (downloads only with
   `--download-models`);
4. opens a **throw-away** store `<stateDir>/plur1bus-selftest-<random>`, embeds
   and captures two probe texts, recalls both, reranks when a local reranker
   with artefacts is configured, closes, and deletes the store unless `--keep`.

A remote embedding provider is not called unless `--remote` is given (that step
reports `skipped: remote-provider`). A missing model without
`--download-models` skips embed, capture and recall with the warning
`model-missing` and leaves the result `ok`.

`--json` prints one `plur1bus.selftest/1` document: `ok`, `addons`, `model`,
`steps`, `warnings`, `errors`. **Reading a failed native addon:** an entry
`{ "name": "onnxruntime-node", "ok": false, "package": "...", "error": "..." }`
and the error line `addon <name> failed to load (<package>)` mean the prebuilt
binary for this platform is missing or does not load. Check that `package` is
installed under the plugin directory (a failed or `--ignore-scripts`-trimmed
dependency install), that the target is one of the five supported ones, and
that OpenClaw's Node matches the range; then reinstall the plugin. A failing
selftest fails the install verify and triggers the rollback.

## Privacy: what is read, written and snapshotted

- The installer never opens `openclaw.json` and never reads a credential:
  not `auth-profiles.json`, not `<state>/credentials/**`, not
  `plugins.entries.<id>.config` as a whole. It reads exactly these paths with
  `openclaw config get`: `plugins.slots.memory`, `…config.baseDbPath`,
  `…config.embedding.provider`, `…config.embedding.model`,
  `…config.modelPreparation.profile`, `…config.reranker.enabled`,
  `…config.reranker.provider`, and two non-secret booleans read only to restore
  them on a rollback (`…config.modelPreparation.acceptNonCommercialLicense`,
  `…hooks.allowConversationAccess`). It writes only through `openclaw config
  set`, only the keys listed in step 9.
- Nothing talks to ClawHub, npm or the Gateway except through the `openclaw`
  CLI. The scripts download only the feed, its signature, the installer
  bundle, the bootstraps and (default tarball source) the release tarball named
  by the signed feed; `--offline` downloads nothing.
- A snapshot contains the memory store and the plugin's run state files listed
  above, and never config or credentials.
- The installer state file (`<stateDir>/memory/.plur1bus-installer.json`, mode
  0600) holds slots, versions, the licence acceptance and artefact digests, no
  config values.
- Tests never touch a real OpenClaw: they run against `openclaw`, `node` and
  `wsl.exe` shims in a temp home, and real OpenClaw runs only in CI on
  disposable runners.
