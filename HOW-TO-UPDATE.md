# How To Update

Safe update workflow for PLUR1BUS on OpenClaw.

Current validated target: OpenClaw `2026.5.12-beta.8` with
`memory-lancedb-namespaced@3.2.0-beta.1`.

## Update Rules

- Do not update the live OpenClaw instance before an isolated compatibility pass.
- Do not use bare `openclaw` in compatibility lanes; use the exact isolated prefix binary.
- Do not install OpenClaw with `npm install -g` for compatibility validation.
- PLUR1BUS must stay an augment plugin: no `kind: "memory"` and no `registerMemoryCapability`.
- `memory-core` remains the memory slot owner.
- The first-class plugin evidence is an OpenClaw managed `npm-pack:` install, not a plain archive install.

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
      | bash -s -- --prefix "$BASE/prefix" --version 2026.5.12-beta.8 --no-onboard --json
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

Expected version includes `2026.5.12-beta.8`.

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

Profile: `plur1bus-beta8-v32-link`

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
  "$BASE/prefix/bin/openclaw" --profile plur1bus-beta8-v32-link \
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
"$BASE/prefix/bin/openclaw" --profile plur1bus-beta8-v32-link plugins inspect memory-lancedb-namespaced --json
"$BASE/prefix/bin/openclaw" --profile plur1bus-beta8-v32-link plugins inspect memory-lancedb-namespaced --json --runtime
"$BASE/prefix/bin/openclaw" --profile plur1bus-beta8-v32-link plugins doctor
"$BASE/prefix/bin/openclaw" --profile plur1bus-beta8-v32-link plugins inspect memory-core --json --runtime
"$BASE/prefix/bin/openclaw" --profile plur1bus-beta8-v32-link capability embedding providers --json
```

The short commands above are only readable examples. Execute them through
`runuser -u kimi -- env ...`, as shown in the install command.

## 5. Lane B: Managed npm-pack Install

Profile: `plur1bus-beta8-v32-tarball`

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
  "$BASE/prefix/bin/openclaw" --profile plur1bus-beta8-v32-tarball \
    plugins install "npm-pack:$BASE/artifacts/memory-lancedb-namespaced-3.2.0-beta.1.tgz"
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

## 7. Upstream Review Gate

For a new OpenClaw target, compare from the last validated tag:

```bash
/root/openclaw-memory-system/scripts/clawsweeper-gate.sh 2026.5.12-beta.6 2026.5.12-beta.8 --no-block
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
