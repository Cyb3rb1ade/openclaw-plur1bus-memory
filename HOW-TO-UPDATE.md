# How To Update

Safe update path for plur1bus deployments on OpenClaw `2026.4.29+`.

Validated target: OpenClaw `2026.5.3-1` with the local `apply-openclaw-20260503-compat.sh` patch.

## 1. Check Current State

```bash
openclaw --version
openclaw status
test -f /root/.openclaw/extensions/memory-lancedb-stock/node_modules/@lancedb/lancedb/dist/index.js
test -f /root/.openclaw/extensions/memory-lancedb-stock/index.js
openclaw plugins doctor
git -C /root/openclaw-memory-system status --short
/root/openclaw-memory-system/scripts/clawsweeper-gate.sh "$(openclaw --version)" 2026.5.3-1 --no-block
```

ClawSweeper is intentionally unbounded (`CLAWSWEEPER_COMPARE_LIMIT=0`) so large ranges such as the 2026.4.29 -> 2026.5.3-1 jump scan every upstream commit, not only the first 250.

OpenClaw `2026.5.3-1` no longer exposes `openclaw plugins deps --json`. The local check is now explicit file validation for the LanceDB/OpenAI runtime dependency tree plus `openclaw plugins doctor`.

The healthy `plugins doctor` output should not contain `contracts.tools` diagnostics for `memory-lancedb-namespaced` or `adaptive-learning-loop`.

## 2. Update OpenClaw

On the production host use:

```bash
/root/openclaw-memory-system/scripts/update-openclaw.sh
```

The script preserves the systemd drop-in that runs the patch chain before gateway startup.
Before installing, it unpacks `openclaw@2026.5.3-1`, runs `patches/apply-openclaw-20260503-compat.sh` against that copy, and aborts if the patch or `node --check` validation fails.

## 3. Reapply plur1bus Patches

After every OpenClaw update:

```bash
bash /root/openclaw-memory-system/patches/apply-memory-patches.sh
systemctl --user restart openclaw-gateway
```

`apply-memory-patches.sh` dispatches by installed OpenClaw version:

- `2026.4.29` -> `apply-openclaw-20260429-compat.sh`
- `2026.5.3-1` -> `apply-openclaw-20260503-compat.sh`

Wait for:

```text
[gateway] agent model: ...
[gateway] http server listening ...
[gateway] ready
```

## 4. Verify Memory

```bash
openclaw plugins list
openclaw status
node /root/openclaw-memory-system/scripts/memory-doctor.mjs stats
```

Expected plugins include:

- `active-memory`
- `memory-core`
- `memory-lancedb-namespaced`

## 5. Verify Provider Routing

plur1bus does not require a specific OpenClaw chat provider. If the deployment intentionally uses explicit agent/session/cron model routes, verify that the update preserved them:

```bash
jq '.agents.defaults.model' ~/.openclaw/openclaw.json
jq '[.jobs[] | select(.payload.kind? == "agentTurn") | {name, model:.payload.model}]' ~/.openclaw/cron/jobs.json
```

Native OpenClaw `agents.defaults.memorySearch` is optional and independent from plur1bus. Disabling it does not disable plur1bus LanceDB Auto-Recall/Auto-Capture.

## 6. Publish a plur1bus Release

```bash
cd /root/openclaw-memory-system
./scripts/bump-version.sh 2.1.23
git add -A
git commit -m "fix: add OpenClaw 2026.5.3-1 compat patch"
git tag -a v2.1.23 -m "v2.1.23"
git push origin main
git push origin v2.1.23
```
