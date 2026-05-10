# How To Update

Safe update path for plur1bus deployments on OpenClaw `2026.4.29+`.

Validated target: OpenClaw `2026.5.7` with the local `apply-openclaw-20260504-compat.sh` patch.

## 1. Check Current State

```bash
openclaw --version
openclaw status
test -f ~/.openclaw/extensions/memory-lancedb-stock/node_modules/@lancedb/lancedb/dist/index.js
test -f ~/.openclaw/extensions/memory-lancedb-stock/index.js
openclaw plugins doctor
git -C /path/to/openclaw-plur1bus-memory status --short
./scripts/clawsweeper-gate.sh "$(openclaw --version)" 2026.5.7 --no-block
```

ClawSweeper is intentionally unbounded (`CLAWSWEEPER_COMPARE_LIMIT=0`) so large ranges scan every upstream commit, not only the first 250. If an installed version is not available as a GitHub tag or npm `gitHead`, the gate can resolve the short commit shown by `openclaw --version`.

Treat ClawSweeper as an update gate, not as a FYI report:

- Copy the commit range, finding counts and high findings into the release notes or compatibility plan.
- Do not ignore high findings. Mark each one as fixed locally, accepted as not instance-relevant, or blocked upstream.
- Do not silently accept large unreviewed ranges. If the report includes unreviewed commits, record the count and run the guarded update check before touching production.
- Recheck model/provider routing after the update. For production cron jobs that must stay on a specific model, set `payload.fallbacks` to `[]`; otherwise default OpenClaw fallbacks can route failed cron turns to an unsupported model.

OpenClaw `2026.5.3-1+` no longer exposes `openclaw plugins deps --json`. The local check is now explicit file validation for the LanceDB/OpenAI runtime dependency tree plus `openclaw plugins doctor`.

The healthy `plugins doctor` output should not contain `contracts.tools` diagnostics for `memory-lancedb-namespaced`.

## 2. Update OpenClaw

```bash
npm i -g openclaw@<target-version>
```

## 3. Update plur1bus Plugin

Pull the latest plur1bus sources, then re-run the installer in plugin-only mode:

```bash
git -C /path/to/openclaw-plur1bus-memory pull
./scripts/install-memory-system.sh --update-plugin-only
```

This syncs `memory-lancedb-namespaced` to the running OpenClaw installation and refreshes the plugin registry. No API-key prompts, no config changes.

## 4. Reapply plur1bus Patches

After every OpenClaw update:

```bash
bash /path/to/openclaw-plur1bus-memory/patches/apply-memory-patches.sh
systemctl --user restart openclaw-gateway
```

`apply-memory-patches.sh` dispatches by installed OpenClaw version:

- `2026.4.29` → `apply-openclaw-20260429-compat.sh`
- `2026.5.3-1` → `apply-openclaw-20260503-compat.sh`
- `2026.5.4`, `2026.5.5`, `2026.5.6`, `2026.5.7` → `apply-openclaw-20260504-compat.sh`

Wait for:

```text
[gateway] agent model: ...
[gateway] http server listening ...
[gateway] ready
```

## 5. Verify Memory

```bash
openclaw plugins list
openclaw status
node /path/to/openclaw-plur1bus-memory/scripts/memory-doctor.mjs stats
```

Expected plugins include:

- `active-memory`
- `memory-core`
- `memory-lancedb-namespaced`

## 6. Verify Provider Routing

plur1bus does not require a specific OpenClaw chat provider. If the deployment intentionally uses explicit agent/session/cron model routes, verify that the update preserved them:

```bash
jq '.agents.defaults.model' ~/.openclaw/openclaw.json
jq '[.jobs[] | select(.payload.kind? == "agentTurn") | {name, model:.payload.model, fallbacks:.payload.fallbacks, thinking:.payload.thinking}]' ~/.openclaw/cron/jobs.json
```

Native OpenClaw `agents.defaults.memorySearch` is optional and independent from plur1bus. Disabling it does not disable plur1bus LanceDB Auto-Recall/Auto-Capture.

## 7. Publish a plur1bus Release

```bash
cd /path/to/openclaw-plur1bus-memory
./scripts/bump-version.sh 2.1.28
git add -A
git commit -m "fix(v2.1.28): support openclaw 2026.5.7"
git tag -a v2.1.28 -m "v2.1.28"
git push origin main
git push origin v2.1.28
```
