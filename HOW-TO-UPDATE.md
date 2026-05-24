# How To Update

Safe update workflow for PLUR1BUS on OpenClaw.

Current repository release target: OpenClaw `2026.5.20` with
`@cyb3rb1ade/plur1bus-memory@4.0.2`.

Live `~/.openclaw` update record, 2026-05-23:

- Rollback bundle:
  `~/.openclaw/backups/update-openclaw-plur1bus/<timestamp>`
- Installed OpenClaw: `2026.5.20 (e510042)`
- Installed PLUR1BUS: `@cyb3rb1ade/plur1bus-memory@3.5.0` from archive
  `cyb3rb1ade-plur1bus-memory-3.5.0.tgz`
- Preserved invariant: `plugins.slots.memory = "memory-core"`; PLUR1BUS
  stayed `kind: "extension"` and exposes `memory_recall`, `memory_store`,
  `memory_forget`, and `knowledge_update`.
- Verification: config validate, gateway health, plugin inspect/doctor,
  provider-check, `node --check`, and package tests passed. Deep security
  audit completed with pre-existing trust/channel warnings and the known
  PLUR1BUS scanner warning for file-read plus network-send code.
- Patch status: `apply-media-patch.sh` remains the gateway `ExecStartPre`
  path and ran on restart; OpenClaw `2026.5.20` intentionally has no
  version-specific PLUR1BUS compat patch.

## Update Rules

- Do not update the live OpenClaw instance before a backup and compatibility pass.
- Do not use bare `openclaw` in compatibility lanes; use the exact isolated prefix binary.
- Do not install OpenClaw with `npm install -g` for compatibility validation.
- PLUR1BUS must stay an augment plugin: no `kind: "memory"` and no `registerMemoryCapability`.
- `memory-core` remains the memory slot owner.
- The first-class plugin evidence is an OpenClaw managed `npm-pack:` install, not a plain archive install.
- Personal `~/.openclaw` updates must keep version-specific dist patches gated;
  OpenClaw `2026.5.20` currently uses no dedicated PLUR1BUS compat patch.
- Preserve local patch edits such as the `gsd/2.77.0` Kimi/Cohere
  `User-Agent` normalization instead of reverting them to older rollback values.
- Obsidian Bridge stays default-off, approval-gated, and augment-only. It must
  never write LanceDB directly, never overwrite `memory/KNOWLEDGE.md` from
  Obsidian, and never mutate memory from a ReviewBundle without explicit
  approval plus immediate revalidation.
- PLUR1BUS/LanceDB remains the authoritative memory system. Obsidian records,
  dashboards, semantic conflicts, duplicates, provenance graphs, and impact
  analyses are proposal/control-room artifacts only.
- Neo workspace-card migration is explicit only. It must not run from
  `npm postinstall`, and non-dry-run migration requires a fresh backup
  directory passed with `--backup-dir`.

## PLUR1BUS 4.0.1 Workspace Cards Harmonization

Use this corrective lane when existing Neo data lives under legacy basename keys
derived from workspace directory names instead of configured workspace IDs.

1. Create a rollback bundle before install or migration:

```bash
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP="$OPENCLAW_HOME/backups/plur1bus-4.0.1-workspace-cards/$TS"
mkdir -p "$BACKUP"
cp -a "$OPENCLAW_HOME/openclaw.json" "$BACKUP/openclaw.json"
cp -a "$OPENCLAW_HOME/memory/lancedb-namespaced/_neo" "$BACKUP/_neo"
openclaw plugins inspect memory-lancedb-namespaced > "$BACKUP/plur1bus-inspect.txt"
```

2. Build or install the `4.0.1` package, preserving the local tarball workflow:

```bash
cd /root/openclaw-memory-system/extensions/memory-lancedb-namespaced
npm pack --dry-run --json
npm pack --json
openclaw plugins install --force ./cyb3rb1ade-plur1bus-memory-4.0.1.tgz
```

3. Discover local workspace mappings. Discovery is dry-run by default and uses
OpenClaw agent config plus local workspace markers:

```text
/plur1bus obsidian discover workspaces --dry-run --verbose
```

If the dry-run looks correct, merge only missing mappings into
`obsidianBridge.workspaces`:

```text
/plur1bus obsidian discover workspaces --write --backup-dir ~/.openclaw/backups/plur1bus-4.0.1-workspace-cards/<timestamp> --verbose
```

You can also configure mappings manually:

```json
[
  { "workspace_id": "primary", "agent_id": "primary-agent", "path": "~/path/to/primary-workspace", "label": "Primary" },
  { "workspace_id": "secondary", "agent_id": "secondary-agent", "path": "~/path/to/secondary-workspace", "label": "Secondary" }
]
```

4. Initialize workspace directories idempotently:

```text
/plur1bus obsidian init workspaces --dry-run --verbose
/plur1bus obsidian init workspaces --verbose
```

5. Run migration dry-run, review the summary, then apply with the backup path:

```text
/plur1bus neo workspaces migrate --dry-run --verbose
/plur1bus neo workspaces migrate --verbose --backup-dir ~/.openclaw/backups/plur1bus-4.0.1-workspace-cards/<timestamp>
```

Migration copies legacy JSONL data into canonical dirs, de-dupes by record `id`,
keeps canonical records when the same `id` exists in both places, and leaves
legacy source files unchanged.

6. Verify:

```bash
openclaw config validate
openclaw plugins doctor
openclaw plugins inspect memory-lancedb-namespaced
find "${OPENCLAW_HOME:-$HOME/.openclaw}/memory/lancedb-namespaced/_neo/workspaces" -maxdepth 2 -name "behavior-cards.jsonl" -print
```

Rollback: restore `openclaw.json`, restore the backed-up `_neo` directory, reinstall
the previous package artifact, restart the gateway, and rerun the verification
commands above.

## 1. Prepare Isolated Test Base

```bash
BASE="$(mktemp -d /tmp/plur1bus-update-XXXXXX)"
runuser -u kimi -- mkdir -p "$BASE/src" "$BASE/artifacts" "$BASE/tmp"
```

Copy or archive the current repo into:

```text
$BASE/src/openclaw-memory-system
```

The test paths must be owned by the non-root test user. OpenClaw blocks unsafe
world-writable plugin paths.

## 2. Install Exact OpenClaw Target

Use `install-cli.sh` in the isolated prefix:

```bash
runuser -u kimi -- env -u OPENCLAW_ALLOW_ROOT \
  BASE="$BASE" \
  HOME="$BASE/home-install" \
  USERPROFILE="$BASE/home-install" \
  OPENCLAW_HOME="$BASE/home-install/.openclaw" \
  XDG_CONFIG_HOME="$BASE/home-install/.config" \
  XDG_CACHE_HOME="$BASE/home-install/.cache" \
  XDG_DATA_HOME="$BASE/home-install/.local/share" \
  TMPDIR="$BASE/tmp" \
  NPM_CONFIG_PREFIX="$BASE/npm-global" \
  NPM_CONFIG_CACHE="$BASE/npm-cache" \
  bash -lc '
    curl -fsSL --proto "=https" --tlsv1.2 https://openclaw.ai/install-cli.sh \
      | bash -s -- --prefix "$BASE/prefix" --version 2026.5.20 --no-onboard --json
  '
```

Verify:

```bash
runuser -u kimi -- test -x "$BASE/prefix/bin/openclaw"
runuser -u kimi -- env -u OPENCLAW_ALLOW_ROOT \
  HOME="$BASE/home-install" \
  USERPROFILE="$BASE/home-install" \
  OPENCLAW_HOME="$BASE/home-install/.openclaw" \
  XDG_CONFIG_HOME="$BASE/home-install/.config" \
  XDG_CACHE_HOME="$BASE/home-install/.cache" \
  XDG_DATA_HOME="$BASE/home-install/.local/share" \
  TMPDIR="$BASE/tmp" \
  NPM_CONFIG_PREFIX="$BASE/npm-global" \
  NPM_CONFIG_CACHE="$BASE/npm-cache" \
  "$BASE/prefix/bin/openclaw" --version
```

Expected version includes `2026.5.20`.

## 3. Run PLUR1BUS Static Checks

```bash
node --check extensions/memory-lancedb-namespaced/index.js
node --check extensions/memory-lancedb-namespaced/lib/providers/openclaw-memory-embedding-adapters.js
node --test extensions/memory-lancedb-namespaced/__tests__/*.test.js
npm pack ./extensions/memory-lancedb-namespaced
```

The tarball must include
`lib/providers/openclaw-memory-embedding-adapters.js` and must not include model
caches.

## 4. Lane A: Linked Plugin

Profile: `plur1bus-4-0-0-obsidian-link`

Every command must use the full non-root environment:

```bash
runuser -u kimi -- env -u OPENCLAW_ALLOW_ROOT \
  HOME="$BASE/home-link" \
  USERPROFILE="$BASE/home-link" \
  OPENCLAW_HOME="$BASE/home-link/.openclaw" \
  XDG_CONFIG_HOME="$BASE/home-link/.config" \
  XDG_CACHE_HOME="$BASE/home-link/.cache" \
  XDG_DATA_HOME="$BASE/home-link/.local/share" \
  TMPDIR="$BASE/tmp" \
  NPM_CONFIG_PREFIX="$BASE/npm-global" \
  NPM_CONFIG_CACHE="$BASE/npm-cache" \
  "$BASE/prefix/bin/openclaw" --profile plur1bus-4-0-0-obsidian-link \
    plugins install --link "$BASE/src/openclaw-memory-system/extensions/memory-lancedb-namespaced"
```

Set the isolated profile config:

```json
{
  "plugins": {
    "entries": {
      "memory-lancedb-namespaced": {
        "enabled": true,
        "hooks": {
          "allowConversationAccess": true,
          "allowPromptInjection": true,
          "timeouts": {
            "before_prompt_build": 90000,
            "agent_end": 60000
          }
        }
      }
    }
  },
  "agents": {
    "defaults": {
      "memorySearch": {
        "provider": "plur1bus-e5-small"
      }
    }
  }
}
```

Then run, again with the same wrapper:

```bash
"$BASE/prefix/bin/openclaw" --profile plur1bus-4-0-0-obsidian-link plugins inspect memory-lancedb-namespaced --json
"$BASE/prefix/bin/openclaw" --profile plur1bus-4-0-0-obsidian-link plugins inspect memory-lancedb-namespaced --json --runtime
"$BASE/prefix/bin/openclaw" --profile plur1bus-4-0-0-obsidian-link plugins doctor
"$BASE/prefix/bin/openclaw" --profile plur1bus-4-0-0-obsidian-link plugins inspect memory-core --json --runtime
"$BASE/prefix/bin/openclaw" --profile plur1bus-4-0-0-obsidian-link capability embedding providers --json
```

The short commands above are only readable examples. Execute them through
`runuser -u kimi -- env ...`, as shown in the install command.

## 5. Lane B: Managed npm-pack Install

Profile: `plur1bus-4-0-0-obsidian-tarball`

Create the package as `kimi`:

```bash
cd "$BASE/src/openclaw-memory-system/extensions/memory-lancedb-namespaced"
runuser -u kimi -- env \
  HOME="$BASE/home-tarball" \
  USERPROFILE="$BASE/home-tarball" \
  OPENCLAW_HOME="$BASE/home-tarball/.openclaw" \
  NPM_CONFIG_PREFIX="$BASE/npm-global" \
  NPM_CONFIG_CACHE="$BASE/npm-cache" \
  npm pack --pack-destination "$BASE/artifacts"
```

Install through OpenClaw managed npm-pack:

```bash
runuser -u kimi -- env -u OPENCLAW_ALLOW_ROOT \
  HOME="$BASE/home-tarball" \
  USERPROFILE="$BASE/home-tarball" \
  OPENCLAW_HOME="$BASE/home-tarball/.openclaw" \
  XDG_CONFIG_HOME="$BASE/home-tarball/.config" \
  XDG_CACHE_HOME="$BASE/home-tarball/.cache" \
  XDG_DATA_HOME="$BASE/home-tarball/.local/share" \
  TMPDIR="$BASE/tmp" \
  NPM_CONFIG_PREFIX="$BASE/npm-global" \
  NPM_CONFIG_CACHE="$BASE/npm-cache" \
  "$BASE/prefix/bin/openclaw" --profile plur1bus-4-0-0-obsidian-tarball \
    plugins install "npm-pack:$BASE/artifacts/cyb3rb1ade-plur1bus-memory-4.0.1.tgz"
```

If `npm-pack:<path>` syntax changes, check:

```bash
"$BASE/prefix/bin/openclaw" plugins install --help
```

Do not count a plain archive install as managed plugin evidence.

Apply the same hook policy as Lane A, then run the same inspect, runtime,
doctor, `memory-core`, and embedding-provider checks.

## 6. Expected Results

PLUR1BUS:

- `kind` is absent in `openclaw.plugin.json`.
- Runtime inspect reports `kind: "extension"`.
- No `registerMemoryCapability` call exists.
- Runtime inspect lists:
  - `agent_end`
  - `before_prompt_build`
  - `gateway_start`
  - `gateway_stop`
- Runtime inspect lists memory embedding providers:
  - `plur1bus-openai`
  - `plur1bus-openai-compatible`
  - `plur1bus-e5-small`
- Obsidian Bridge config exists with `enabled:false`, `mode:"augment"`,
  `requireUserApproval:true`, `applyApprovedOnly:true`,
  `allowDotObsidianWrite:false`, `watch:false`, and
  `tombstoneOnDelete:true`.
- `node scripts/workspace-vault-bridge.mjs init --dry-run` shows only the
  configured target workspaces.
- `node scripts/memory-doctor.mjs obsidian` reports no active legacy `.obsidian`
  after live vault init. Any old `.obsidian` must exist only as
  `.obsidian.legacy-<timestamp>`.

`memory-core`:

- Runtime inspect reports `kind: "memory"`.
- Runtime inspect reports `memorySlotSelected: true`.
- Tools remain `memory_search` and `memory_get`.

Known visibility limit:

- `capability embedding providers --json` may list only OpenClaw's core `local`
  provider. This is acceptable only if `plugins inspect --json --runtime` shows
  the three PLUR1BUS provider IDs.

Known blocked smokes:

- `plur1bus-e5-small` remains experimental until a real local model smoke runs.
- Remote functional memory smokes require a real or deterministic
  OpenAI-compatible test provider.

Obsidian bridge smoke:

```bash
node --check extensions/memory-lancedb-namespaced/lib/obsidian-control-room.js
node --check extensions/memory-lancedb-namespaced/lib/obsidian-bridge.js
node --check scripts/workspace-vault-bridge.mjs
node --test extensions/memory-lancedb-namespaced/__tests__/obsidian-control-room.test.js
node scripts/workspace-vault-bridge.mjs init --dry-run
node scripts/workspace-vault-bridge.mjs scan
node scripts/workspace-vault-bridge.mjs sync --dry-run
node scripts/memory-doctor.mjs obsidian
```

Runtime smoke:

```text
/plur1bus obsidian doctor
/plur1bus obsidian review prepare
/plur1bus obsidian cron print-morning-review
```

Do not enable live gateway watch until the dry-run output is clean and the
control-room tests pass. Rollback is `obsidianBridge.enabled=false`, stop the
watcher, remove/disable the OpenClaw Morning Review cron job, and restore the
previous package/tag if needed. PLUR1BUS memory data remains authoritative.

## 7. Upstream Review Gate

For a new OpenClaw target, compare from the last validated tag:

```bash
/root/openclaw-memory-system/scripts/clawsweeper-gate.sh 2026.5.19 2026.5.20 --no-block
```

ClawSweeper is a gate input, not a substitute for local review. Classify every
high, medium, and unreviewed relevant finding as:

- `blocker`
- `plur1bus-fix-required`
- `smoke-required`
- `no-direct-impact`
- `integration-opportunity`

Also classify every commit in the exact Git range. The beta8 review found 78
commits from beta6 to beta8.

## 8. Publish PLUR1BUS

Only publish after:

- Static/unit/pack checks pass.
- Isolated install-cli target install passes.
- Link lane passes.
- Managed `npm-pack:` lane passes or is clearly blocked by OpenClaw syntax.
- `hooks.allowConversationAccess=true` is verified.
- `memory-core` remains slot owner.
- Provider Bridge is visible in runtime inspect or the visibility limit is
  documented.
- Existing v3.1/v3.2 behavior is pass or provider-blocked.

Then commit intentionally:

```bash
git status --short
git add <changed-files>
git commit -m "docs: update OpenClaw update workflow"
git push
```
