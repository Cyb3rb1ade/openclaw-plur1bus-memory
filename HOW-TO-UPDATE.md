# How To Update

Safe update path for plur1bus deployments on OpenClaw `2026.4.29+`.

## 1. Check Current State

```bash
openclaw --version
openclaw status
openclaw plugins deps --json
git -C /root/openclaw-memory-system status --short
```

`openclaw plugins deps --json` should report no missing dependencies before and after the update:

```json
{
  "missing": [],
  "conflicts": []
}
```

## 2. Update OpenClaw

On the production host use:

```bash
/root/openclaw-memory-system/scripts/update-openclaw.sh
```

The script preserves the systemd drop-in that runs the patch chain before gateway startup.

## 3. Reapply plur1bus Patches

After every OpenClaw update:

```bash
bash /root/openclaw-memory-system/patches/apply-memory-patches.sh
systemctl --user restart openclaw-gateway
```

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

## 5. Kimi-only Deployments

If the deployment is intentionally Kimi-only, verify:

```bash
jq '.agents.defaults.model' ~/.openclaw/openclaw.json
jq '[.jobs[] | select(.payload.kind? == "agentTurn") | {name, model:.payload.model}]' ~/.openclaw/cron/jobs.json
```

Expected model:

```text
kimi-coding/kimi-for-coding
```

Expected fallback list:

```json
[]
```

Native OpenClaw `agents.defaults.memorySearch` may be disabled in Kimi-only/no-OpenAI-token setups. This does not disable plur1bus LanceDB Auto-Recall/Auto-Capture.

## 6. Publish a plur1bus Release

```bash
cd /root/openclaw-memory-system
./scripts/bump-version.sh 2.1.20
git add -A
git commit -m "fix: harden OpenClaw 2026.4.29 runtime deps and docs"
git tag -a v2.1.20 -m "v2.1.20"
git push origin main
git push origin v2.1.20
```
