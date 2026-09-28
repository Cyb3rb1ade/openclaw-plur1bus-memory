# OpenClaw CLI facts for plugin distribution (HM1 spike)

Captured 2026-09-28/29 on disposable OpenClaw instances. Later HM1 tasks
(selftest, installer, bootstraps, CI) quote the **Use this** rules below and
never assume behaviour this sheet does not record. Fixtures live in
`tests/fixtures/openclaw-cli/`.

## Environment and method

| Item | Value |
|---|---|
| OS | Linux x64 (glibc), kernel 6.x, no systemd user bus, no Gateway running |
| OpenClaw `min` | `2026.8.1` (`OpenClaw 2026.8.1 (ea80657)`), = `openclaw.compat.minGatewayVersion` |
| OpenClaw `latest` | `2026.9.6` (`OpenClaw 2026.9.6 (eb377ac)`), npm `dist-tags.latest` on 2026-09-28 |
| Installer | `https://openclaw.ai/install-cli.sh` (reachable; **no npm fallback was needed**) |
| Install command | `bash install-cli.sh --prefix $T/oc-<v> --version <v> --json` |
| Isolation | `HOME=OPENCLAW_HOME=$T/home-<v>`, `OPENCLAW_STATE_DIR=$T/state-<v>`, both asserted to be under the temp dir `$T` before any command; `OPENCLAW_PROFILE`/`OPENCLAW_CONFIG_PATH` unset; no Gateway started, no service installed |
| Plugin tarballs | `npm pack` of this repo at `b0e149b8` (`7.16.11`, `sha512-Bornxw96…kW6A==`); a scratch `7.16.12-spike.0` repack (version bump, root CLI `plur1bus` added) for the upgrade and CLI questions; ClawHub `7.5.3` and `7.5.4` |

**Redaction in fixtures:** `<state>` = the instance's `OPENCLAW_STATE_DIR`,
`<home>` = `OPENCLAW_HOME`, `<prefix>` = the `install-cli.sh` prefix, `<tmp>` =
any other temp path; ANSI colour codes stripped; **every `@` is written as
`<at>`** (so `@cyb3rb1ade/plur1bus-memory@7.16.11` appears as
`<at>cyb3rb1ade/plur1bus-memory<at>7.16.11`; a replaying shim restores it with
`replaceAll("<at>", "@")`). In the `inspect` JSON fixtures `/plugin/configUiHints`
and `/plugin/configJsonSchema` are replaced by a `"<trimmed: …>"` string: they
are this plugin's own manifest data, not OpenClaw behaviour, and contain
credential field names. Everything else is verbatim. `.txt` fixtures are
stdout+stderr combined unless noted.

## Step 1: where `openclaw` and `node` land (`install-cli.sh`)

- JSON events on stdout, one per line: `{"event":"step","name":"node",…}`,
  `git`, `openclaw`, `{"event":"step","name":"gateway-service","status":"skip","reason":"not-loaded"}`,
  then `{"event":"done","ok":true,"version":"OpenClaw 2026.9.6 (eb377ac)"}`.
  Exit 0 for both versions. Private Node `24.21.0` in both cases.
- Layout: `<prefix>/bin/openclaw` (bash wrapper), `<prefix>/tools/node-v24.21.0/`
  (Node tarball, **also the npm global prefix**: OpenClaw lives in
  `<prefix>/tools/node-v24.21.0/lib/node_modules/openclaw`), and
  `<prefix>/tools/node` = **absolute symlink** to `node-v24.21.0`.
- The wrapper is exactly:
  `exec "<prefix>/tools/node/bin/node" "<prefix>/tools/node-v24.21.0/lib/node_modules/openclaw/dist/entry.js" "$@"`.
- Without `--runtime-only` the installer runs `openclaw gateway status --json`
  and would `gateway install --force` **only if a service is loaded**; on a
  disposable runner that is `skip not-loaded`. `--runtime-only` skips even
  that probe (and `ensure_git`).
- `OPENCLAW_HOME` is honoured, but the installer still writes `~/.npm` logs and
  (with `--set-npm-prefix`) `~/.bashrc`/`~/.zshrc` under `HOME`: set `HOME` to
  the temp dir too.
- OpenClaw writes its log to **`/tmp/openclaw/openclaw-<date>.log`** and
  extracts ClawHub packs under `/tmp/openclaw/…`, independent of
  `OPENCLAW_STATE_DIR` and `TMPDIR` (see `/logFile` in
  `gateway-status-stopped.json`).

**Use this:** POSIX: `node` = `<prefix>/tools/node/bin/node` (resolve the
symlink or read it from the wrapper's `exec` line); CI passes
`--prefix "$RUNNER_TEMP/oc"` and sets `HOME`, `OPENCLAW_HOME` and
`OPENCLAW_STATE_DIR` under `$RUNNER_TEMP`. `install.ps1` Node location and
the `openclaw.cmd` shim: **unverified on Windows; macOS layout unverified on
macOS — verify in Task 8 CI** (see "Not answered").

## (a) `openclaw --version`

- Command: `openclaw --version`; exit 0; one line on stdout:
  `OpenClaw 2026.8.1 (ea80657)` / `OpenClaw 2026.9.6 (eb377ac)`.
  Fixtures `version-2026.8.1.txt`, `version-latest.txt`.
- `openclaw --version --json` is **not** a version query: it falls through to
  onboarding and prints `Onboarding needs an interactive TTY…`.

**Use this:** parse `^OpenClaw (\d{4}\.\d+\.\d+(?:-[0-9A-Za-z.]+)?) \(([0-9a-f]+)\)$`
from the first stdout line; never pass `--json` to `--version`.

## (b) `plugins inspect memory-lancedb-namespaced --json`

Commands (both versions):
`openclaw plugins inspect memory-lancedb-namespaced --json` before install,
after `openclaw plugins install npm-pack:<tgz> --force --accept-capabilities`,
and with `--runtime`.

- **Not installed:** exit **1**, stdout is JSON
  `{"ok":false,"error":{"type":"cli_error","message":"Plugin not found: memory-lancedb-namespaced. …"}}`
  (`inspect-not-installed.json`), stderr empty.
- **Installed:** exit 0, ~110 KB JSON (`inspect-installed.json`, 2026.9.6;
  `inspect-installed-2026.8.1-slot-unset.json`, 2026.8.1).
  `--runtime` loads the plugin in the CLI process (`inspect-runtime-loaded.json`,
  2026.9.6, 7.16.11). Stderr of `inspect --json` is empty; `--runtime` adds
  plugin log lines on stderr only.

| Meaning | JSON pointer | Observed |
|---|---|---|
| registry status | `/plugin/status` | `"loaded"`, or `"disabled"` (2026.8.1, slot unset) |
| runtime import happened | `/plugin/imported` | `false` without `--runtime`, `true` with it |
| enabled / activated | `/plugin/enabled`, `/plugin/activated`, `/plugin/activationReason` | `true`/`true`/`"selected memory slot"`; 2026.8.1 slot unset: `false`/`false`/`"memory slot set to \"memory-core\""` and `/plugin/error` = same text |
| memory slot selected | `/plugin/memorySlotSelected` | `true` (2026.9.6 only; absent in 2026.8.1) |
| installed version | `/install/version` (also `/install/resolvedVersion`, `/plugin/version`, `/plugin/packageVersion`) | `"7.16.11"` |
| install source | `/install/source` | `"npm"` for **`npm-pack:`** installs too; `"clawhub"` for ClawHub |
| artefact kind | `/install/artifactKind`, `/install/artifactFormat` | `"npm-pack"`, `"tgz"` (both sources) |
| recorded spec | `/install/spec` | `"@cyb3rb1ade/plur1bus-memory@7.16.11"` (npm-pack), `"clawhub:@cyb3rb1ade/plur1bus-memory@7.5.3"` (ClawHub) |
| local tarball path | `/install/sourcePath` | the `.tgz` passed to `npm-pack:` (npm-pack only) |
| npm integrity | `/install/npmIntegrity` | sha512 SRI; present for npm-pack **and** ClawHub |
| npm shasum | `/install/npmShasum` | sha1 hex |
| generic integrity | `/install/integrity` | = `npmIntegrity` for npm-pack; **sha256 of the ClawPack** for ClawHub |
| ClawPack digest | `/install/clawpackSha256`, `/install/clawpackSize` | ClawHub only |
| install path (plugin dir) | `/install/installPath` (= `/plugin/rootDir`) | `<state>/npm/projects/cyb3rb1ade-plur1bus-memory-<hash10>[__openclaw-generation__g-<hash16>]/node_modules/@cyb3rb1ade/plur1bus-memory` (npm-pack); `<state>/extensions/memory-lancedb-namespaced` (ClawHub) |
| trust | `/plugin/trust/reason` (2026.9.6 only) | `"origin-path"` tracked; `"record-missing"` untracked |
| CLI roots (runtime) | `/cliCommands` and `/plugin/cliCommands` | `[]` without `--runtime`; names with `--runtime` |
| diagnostics | `/diagnostics[*].message` | see (i) note on `allowConversationAccess` |

- `--force` re-installs of npm-pack create a **new generation directory**
  (`…__openclaw-generation__g-<hash>`), so `/install/installPath` changes on
  every install/upgrade; old generations stay on disk (≈ 580 MB each for this
  plugin, not garbage-collected during the spike).
- `status` is `"loaded"` even without `--runtime` when the plugin is enabled and
  selected; only `/plugin/imported` tells whether the code was actually
  imported.

**Use this:** installed ⇔ exit 0 and `/install` present; tracked version =
`/install/version`; plugin dir = `/install/installPath` read fresh after every
install (never cached, never derived); integrity check = `/install/npmIntegrity`
(not `/install/integrity`); runtime OK ⇔ `inspect --runtime --json` exit 0,
`/plugin/status == "loaded"` and `/plugin/imported == true`. "Not installed" is
exit 1 with `/ok == false` and `/error/message` starting `Plugin not found:`.

## (c) Memory slot and enabled state after install

- `openclaw config get plugins.slots.memory` after
  `plugins install npm-pack:<tgz> --force --accept-capabilities` on a fresh
  state dir:
  - **2026.8.1: unset** (exit 1, "Config path is valid but unset: plugins.slots.memory …").
    The plugin is then `/plugin/status "disabled"`, `/plugin/enabled false`,
    reason `memory slot set to "memory-core"`, although
    `plugins.entries.memory-lancedb-namespaced.enabled` is `true`.
  - **2026.9.6: set** to `memory-lancedb-namespaced` (`config-get-slot.txt`,
    exit 0, stdout `memory-lancedb-namespaced`).
- Plugin config absent: 2026.8.1 leaves `plugins.entries.<id>.config` unset
  and records `enabled: true`; 2026.9.6 **seeds** `plugins.entries.<id>.config`
  from the manifest defaults (e.g. `language: "de"`, `autoCapture: true`) and
  records `enabled: true`. Neither version recorded the entry **disabled**.
- `openclaw config set plugins.slots.memory memory-lancedb-namespaced` works on
  both after install (2026.8.1 prints "Change will apply without restarting the
  gateway."), and fails with `Config validation failed: plugins.slots.memory:
  plugin not found: memory-lancedb-namespaced` (exit 1) while no plugin with
  that id is discoverable.
- `config get <unset path>` exits **1** with "Config path is valid but unset";
  an unknown path also exits 1 ("Unknown config path"). `plugins.installs` is
  not a config path (install records live in `<state>/state/openclaw.sqlite`).

**Use this:** after every fresh install or adoption, read
`plugins.slots.memory`; if it is not `memory-lancedb-namespaced`, run
`openclaw config set plugins.slots.memory memory-lancedb-namespaced` (keeping
the previous value in the installer state file, HM1-R10). Do not run
`plugins enable` on the basis of "recorded disabled": it was not observed.
Treat `config get` exit 1 + "valid but unset" as *unset*, not as an error.

## (d) `plugins install` of an already installed id

- npm-pack / npm / bare id without `--force` (no TTY): the non-ClawHub source
  confirmation fires **first**: `WARNING - Installing plugin from local npm-pack
  archive: … Install cancelled; rerun with --force after reviewing the source.`
  exit **1**; nothing changes. `openclaw plugins install memory-lancedb-namespaced`
  treats the id as an npm registry spec and cancels the same way.
- ClawHub source without `--force`, id already installed (tracked, ClawHub,
  2026.9.6): downloads, then
  `plugin already exists: <state>/extensions/memory-lancedb-namespaced (delete it first)`,
  exit **1** (`install-already-installed.txt`). It does **not** name
  `plugins update`.
- ClawHub source without `--force` over an **npm-pack** install (different
  install dir): no "already exists" stop at all; it proceeds to the capability
  prompt (`requires capability consent … Re-run … with --accept-capabilities`,
  exit 1, nothing changed on either version).
- With `--force --accept-capabilities` any source overwrites/replaces the
  install record, exit 0.

**Use this:** never rely on OpenClaw to refuse a re-install: decide
install-vs-update from `plugins inspect --json` (`/install` present) before
calling anything. Expect exit 1 with either "Install cancelled; rerun with
--force" or "plugin already exists … (delete it first)" if a non-forced
install hits an existing plugin.

## (e) Exact-version upgrade

All four forms on both versions against the npm-pack install (7.16.11), the
package being absent from npmjs.org (P5):

| Command | Result |
|---|---|
| `plugins update memory-lancedb-namespaced --dry-run` | exit 1, `Failed to check memory-lancedb-namespaced: npm package not found for @cyb3rb1ade/plur1bus-memory@7.16.11.` (`update-dry-run.txt`) — the recorded source of an npm-pack install is the **npm registry spec**, not the local tarball |
| `plugins update npm:@cyb3rb1ade/plur1bus-memory@7.16.12 --dry-run` | exit 1, `No tracked plugin or hook pack found for "npm:@cyb3rb1ade/plur1bus-memory@7.16.12".` — **`npm:` prefix not accepted by `update`** |
| `plugins update @cyb3rb1ade/plur1bus-memory@7.16.12 --dry-run` | exit 1, `Failed to check memory-lancedb-namespaced: npm package not found for @cyb3rb1ade/plur1bus-memory@7.16.12.` — **bare npm spec is accepted** and matched to the tracked plugin by package name |
| `plugins update clawhub:@cyb3rb1ade/plur1bus-memory@7.5.3 --dry-run` | exit 1, `No tracked plugin or hook pack found for "clawhub:…"` — **`clawhub:` prefix not accepted** |

Against a ClawHub install (`clawhub:@cyb3rb1ade/plur1bus-memory@7.5.3`, 2026.9.6):
`update memory-lancedb-namespaced --dry-run` exit 0 `memory-lancedb-namespaced
is up to date (7.5.3).` (the explicit version stays pinned);
`update clawhub:…@7.5.4 --dry-run` and `update @cyb3rb1ade/plur1bus-memory@7.5.4
--dry-run` both exit 1 `No tracked plugin or hook pack found for …`.

What works: `plugins install npm-pack:<new.tgz> --force --accept-capabilities`
(7.16.11 → 7.16.12-spike.0, both versions, exit 0) and
`plugins install clawhub:@cyb3rb1ade/plur1bus-memory@7.5.4 --force --accept-capabilities`
(7.5.3 → 7.5.4, 2026.9.6, exit 0). `update` also takes `--accept-capabilities`
(needed when capabilities widen).

**Use this:** exact-version upgrade of a tracked install =
`openclaw plugins install <same-source-locator>@<ver> --force --accept-capabilities`
(`npm-pack:<verified.tgz>`, `clawhub:<pkg>@<ver>`, or `npm:<pkg>@<ver> --pin`).
`plugins update` is usable only as `update <id>` (re-resolves the recorded
spec; a pinned ClawHub/npm version never moves) or `update <pkg>@<ver>` with a
**bare** npm spec for npm-registry installs. Never pass `npm:`/`clawhub:`
locators to `update`.

## (f) Is `plugins.entries.<id>.config` kept?

`openclaw config set plugins.entries.memory-lancedb-namespaced.config.language en`,
then the operation, then `openclaw config get …config.language` (that key only):

| Operation | 2026.8.1 | 2026.9.6 |
|---|---|---|
| `install npm-pack:<same tgz> --force --accept-capabilities` | kept (`en`) | kept (`en`) |
| `install npm-pack:<newer tgz> --force --accept-capabilities` | kept | kept |
| `install --force` over an untracked legacy dir (g) | kept | kept |
| `install clawhub:…@7.5.4 --force --accept-capabilities` over ClawHub 7.5.3 | — | kept |
| `plugins update <id>` with a real version change | **not observed** (registry 404 / pinned no-op) | **not observed** |

`plugins.slots.memory` and `plugins.entries.<id>.enabled` were also unchanged by
every `--force` re-install.

**Use this:** `install --force` keeps the plugin's config and slot; the
installer still snapshots before and verifies the licence/embedding keys after.
Keeping config across a real `plugins update` is **unverified** — verify in the
Task 8 CI upgrade leg (HM1-R13) once an npm-registry install exists.

## (g) Untracked copy at `<state>/extensions/memory-lancedb-namespaced`

Setup: fresh state dir, unpacked 7.16.11 tarball copied to
`<state>/extensions/memory-lancedb-namespaced` (with its `node_modules`), then
`config set plugins.slots.memory memory-lancedb-namespaced` (exit 0 — the
directory is discovered as a plugin).

- `inspect --json`: exit 0, `/plugin/status "loaded"`, `/plugin/origin "global"`,
  `/plugin/rootDir` = the extensions dir, **`/install` key absent**,
  2026.9.6 `/plugin/trust/reason "record-missing"`, diagnostic
  `OpenClaw can't verify where this plugin came from. …`
  (`inspect-legacy-untracked.json`).
- `plugins update memory-lancedb-namespaced` (with and without `--dry-run`):
  exit 1, `Plugin "memory-lancedb-namespaced" has no authoritative package-owner
  metadata. …` (2026.9.6 adds "run openclaw plugins doctor to inspect the
  install record").
- `plugins install npm-pack:<tgz> --accept-capabilities` (no `--force`): exit 1,
  `Install cancelled; rerun with --force after reviewing the source.`
- `plugins install npm-pack:<tgz> --force --accept-capabilities`: exit 0; the
  tracked install goes to `<state>/npm/projects/…`, **the legacy directory is
  left untouched on disk**, `inspect`/`plugins list --json` then show only the
  tracked copy (`/plugin/rootDir` under `npm/projects`, one entry, no duplicate
  diagnostic), config kept.
- Side finding: when files under a plugin dir are **hard links** (link count
  > 1), OpenClaw rejects the manifest: every `config get` fails with
  `OpenClaw config is invalid: … unsafe plugin manifest path: …/openclaw.plugin.json`
  and `Run openclaw doctor --fix`.

**Use this:** legacy deploy ⇔ `<state>/extensions/memory-lancedb-namespaced`
exists **and** `inspect --json` has no `/install`. Adoption = rename the legacy
dir away, then `install <spec> --force --accept-capabilities` (OpenClaw itself
neither removes nor adopts the legacy dir; without the rename it stays as a
shadowed second copy that `protect-plur1bus-deploy.sh` would keep refreshing).
Snapshots and legacy renames must copy or `rename`, **never hard-link** plugin
files.

## (h) `gateway status --json` without a Gateway

- `openclaw gateway status --json`: exit **0** on both versions
  (`gateway-status-stopped.json`, 2026.9.6). Also exit 0 with `--no-probe`.
- Running-ness: `/rpc/ok` = `false`, `/rpc/error` = `"connect ECONNREFUSED 127.0.0.1:18789"`,
  `/rpc/connectFailure/kind` = `"unreachable"`, `/port/status` = `"free"`,
  `/service/loaded` = `false`, `/service/runtime/status` = `"unknown"`.
  Config location: `/config/cli/path`, `/config/cli/valid`. Log file: `/logFile`.
- 2026.9.6 adds `/service/inspectionReason "service-manager-unavailable"`;
  2026.8.1 reports `"label": "systemd user"` with `systemctl --user unavailable`.

**Use this:** Gateway running ⇔ `gateway status --json` exits 0 **and**
`/rpc/ok === true`; anything else (including a non-zero exit) is "not running"
→ `skipped: gateway-start-reconciles` (HM1-R7). Never use the exit code alone.

## (i) Root CLI `plur1bus` with `hasSubcommands: true`

Scratch 7.16.12-spike.0: manifest row
`{"name":"plur1bus","description":"…","hasSubcommands":true}` and in
`register(api)` an `api.registerCli(({program}) => { program.command("plur1bus")
.command("selftest")… }, { descriptors: [{ name: "plur1bus", hasSubcommands: true, … }] })`.

- Accepted by both versions: install exit 0, no diagnostic; `inspect --runtime
  --json` lists `plur1bus` first in `/cliCommands` and `/plugin/cliCommands`
  (next to the five existing flat roots). No collision.
- `openclaw plur1bus selftest --json` with **no Gateway**: exit 0, the action ran
  in the CLI process and printed
  `{"apiConfigType":"object","apiConfigSlotMemory":"memory-lancedb-namespaced","pluginConfigType":"object","pluginConfigLanguage":"en","registrationMode":"discovery",…}`
  → `api.config` (full host config object) and `api.pluginConfig` (this
  plugin's `plugins.entries.<id>.config`) are both readable inside the action.
  `openclaw plur1bus --help` lists `selftest`.
- The full plugin `register()` runs before the action (stderr shows the
  plugin's registration log lines, e.g. `registered (baseDbPath: …)`), so the
  CLI costs a full plugin load: 9 s (2026.8.1) / 53 s (2026.9.6, first run) on
  the sandbox.
- `api.registrationMode` inside the action is `"discovery"`.
- The runtime also reports, on both versions, for every non-bundled install:
  `typed hook "before_agent_reply" | "agent_end" | "before_prompt_build" blocked
  because non-bundled plugins must set
  plugins.entries.memory-lancedb-namespaced.hooks.allowConversationAccess=true`
  (`/diagnostics`, `inspect-runtime-loaded.json`).
- Plugin-side fact seen in the log: the default `baseDbPath` resolved to
  `<home>/.openclaw/memory/lancedb-namespaced` (`os.homedir()`-based,
  `engine/runtime/constants.js`), **not** `<state>/memory/…`, even with
  `OPENCLAW_STATE_DIR` set.

**Use this:** keep HM1-R5: root `plur1bus`, `hasSubcommands: true`,
subcommand `selftest`; register it on every `register()` call (not only in
`"full"` mode); read settings from `api.pluginConfig`. The installer must also
ensure `plugins.entries.memory-lancedb-namespaced.hooks.allowConversationAccess`
= `true` (capture/recall hooks are blocked otherwise). Resolve the store as
`config.baseDbPath` if set, else `os.homedir()/.openclaw/memory/lancedb-namespaced`
exactly as the plugin does.

## (j) `OPENCLAW_CONFIG_READONLY=1`

| Command | 2026.8.1 | 2026.9.6 |
|---|---|---|
| `OPENCLAW_CONFIG_READONLY=1 openclaw plugins install npm-pack:<tgz> --force --accept-capabilities` | **exit 0, installed and install record updated — not blocked** | exit 1, `Config is externally managed (OPENCLAW_CONFIG_READONLY=1), so OpenClaw treats openclaw.json as immutable. Edit the config in your external deployment source, then redeploy or restart OpenClaw as needed.` |
| `OPENCLAW_CONFIG_READONLY=1 openclaw config set …config.language de` | **exit 0, value written** | exit 1, same message plus `Config path: <state>/openclaw.json` |
| `OPENCLAW_NIX_MODE=1 openclaw plugins update memory-lancedb-namespaced` | exit 1, `[openclaw] Could not start the CLI. Reason: Config is managed by Nix (OPENCLAW_NIX_MODE=1) …` | exit 1, `Config is managed by Nix (OPENCLAW_NIX_MODE=1), so OpenClaw treats openclaw.json as immutable. …` |

**Use this:** the installer checks `OPENCLAW_CONFIG_READONLY=1` and
`OPENCLAW_NIX_MODE=1` **itself** before any change (exit 3, print the matching
OpenClaw remedy text above), because 2026.8.1 (= min) ignores
`OPENCLAW_CONFIG_READONLY`. On ≥ 2026.9.6 an OpenClaw exit 1 with
`Config is externally managed` / `Config is managed by Nix` maps to exit 3 as
well.

## (k) ClawHub vs GitHub-Release tarball integrity (HM1-R15)

- ClawHub still lists `@cyb3rb1ade/plur1bus-memory@7.5.3` (security audit
  outcome "Review", `/install/clawhubTrustScanStatus "suspicious"`).
  `inspect-installed-clawhub.json` (2026.9.6): `/install/integrity`
  `sha256-uCljc6uW…UR0=` (= `/install/clawpackSha256` `b8296373…511d`),
  `/install/npmIntegrity` `sha512-AaSlKrcq…OjuMg==`, `/install/npmShasum`
  `61f72d4f…ee5e`, `/install/clawpackSize` 1231785.
- The GitHub Release asset could not be fetched from this sandbox (the
  release-download URL returned 404 and the GitHub API is not enabled for this
  session). Substitute: `git archive v7.5.3 | npm pack` (npm 10.9.7) gives
  `sha512-dGZgFGOd…u/F0g==`, shasum `1ca8bcb7…6ee7`, 1231797 bytes: **a
  different digest**, although every packaged file is byte-identical to the
  ClawHub-installed files (`diff -r` clean). ClawHub therefore records the
  digest of its own ClawPack re-pack, not of a locally packed tarball.

**Use this:** assume a ClawHub install's `/install/npmIntegrity` does **not**
equal the GitHub-Release tarball's integrity: take the HM1-R15 fallback
(`build-plugin-feed.mjs --clawpack-digest <d>`, feed field `clawpackDigest`,
compared with `/install/clawpackSha256` for `/install/source == "clawhub"`;
`/install/npmIntegrity` for npm-pack and npm installs). Direct comparison with
the real Release asset is **unverified — verify in Task 8/10 CI** where the
asset is reachable.

## Not answered here

| Question | Status |
|---|---|
| `install.ps1 -Tag <v> -NoOnboard`: where `node` lands, `openclaw.cmd`/`.ps1` shim contents, argument quoting of paths with spaces/non-ASCII | **unverified on Windows, verify in Task 8 CI** |
| `install-cli.sh` layout on macOS (`darwin-arm64`) | **unverified on macOS, verify in Task 8 CI** (expected identical, not observed) |
| Throw-away `windows-2025` / `macos-15` workflow run | **not dispatched**: the spike may not push the branch and this sandbox has neither `gh` nor GitHub API access, so no run URL exists |
| `plugins update <id>` keeping `plugins.entries.<id>.config` across a real version change | unverified (no npm-registry install possible, P5); Task 8 upgrade leg |
| Exact byte digest of the GitHub-Release `.tgz` vs ClawHub | unverified (asset unreachable); see (k) |
| Whether OpenClaw ever garbage-collects old `__openclaw-generation__` dirs | not observed during the spike |
