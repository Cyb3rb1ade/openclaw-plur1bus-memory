# PLUR1BUS v3 Compatibility Review: OpenClaw 2026.5.12-beta.3

Date: 2026-05-13

## Result

PLUR1BUS v3 is compatible with OpenClaw `2026.5.12-beta.3` for the tested loader, manifest, linked-plugin runtime facade, hook policy, and non-root installation surfaces.

No PLUR1BUS compatibility code change is required for beta3. The remaining functional memory tool smokes (`memory_store`, `memory_recall`, `memory_forget`, `knowledge_update`) were not counted as beta3 failures because this isolated run had no real embedding key or local embedding stub.

## Target Snapshot

- Release: `v2026.5.12-beta.3`
- Release URL: https://github.com/openclaw/openclaw/releases/tag/v2026.5.12-beta.3
- GitHub release: pre-release, published `2026-05-12T23:38:26Z`
- Beta3 commit: `cc46ca9bee27776a84fc585a28f6cec56e22a03e`
- Previous beta2 commit: `fdb6e92ff57fce02be6d967d915623dd1d327fdb`
- Fresh `origin/main`: `e64a9a05078e7e601a2b1211e68ed5b0ff60738f`
- Merge-base beta3/main: `067e83d121ddb05181b8c97cf8587e591059d6c4`
- Beta2 -> beta3: 3 commits
- Beta3 -> `origin/main`: 873 commits
- Symmetric beta3/main: `30 873`
- npm exact: `openclaw@2026.5.12-beta.3` resolves to `2026.5.12-beta.3`
- npm beta dist-tag: `openclaw@beta` resolves to `2026.5.12-beta.3`

Local PLUR1BUS preflight:

- Branch: `neo-arch-openclaw-current-compat`
- HEAD: `a2531e7f5f343fa3b6156e07e25ab30bb01a7fbd`
- Diff against `neo-arch`: installer minimum-version fix, manifest-schema test, changelog, and prior current-compat review artifacts.

## Release Notes vs. Beta3 Commits

The beta3 release notes are broader/generated context. They mention relevant surfaces including `OPENCLAW_HOME` precedence, plugin SDK/runtime alias fixes, plugin-inspector advisory behavior, dynamic/per-sender tool policies, `cron.get`, session actions, provider/gateway fixes, and memory-wiki scope hardening.

The actual beta2 -> beta3 delta is narrower and was classified from git compare/show/diff:

| Commit | Category | PLUR1BUS impact | Classification |
| --- | --- | --- | --- |
| `b251a74b1c` `fix(plugins): alias codex native runtime for managed installs` | smoke-required | Positive host fix around native runtime aliasing; directly relevant to the linked-plugin smoke path because PLUR1BUS is installed with `plugins install --link`. | no PLUR1BUS fix required |
| `9fd79d7b69` `fix(plugins): keep codex runtime alias in packages` | smoke-required | Positive host fix keeping private Codex runtime alias loadable from installed/package paths. PLUR1BUS does not import the Codex private runtime subpath, but this validates the same plugin-runtime/facade area. | no PLUR1BUS fix required |
| `cc46ca9bee` `chore(release): bump beta 3` | smoke-required | Package/version metadata only. | no direct impact |

## Beta3 Linked-Plugin Runtime Facade Fix

This is directly PLUR1BUS-relevant because the compatibility smoke uses:

```bash
plugins install --link "$BASE/src/openclaw-memory-system/extensions/memory-lancedb-namespaced"
plugins inspect memory-lancedb-namespaced --json
plugins inspect memory-lancedb-namespaced --json --runtime
```

Result:

- Linked install: pass, with expected security advisory and expected initial registration failure before embedding config.
- Inspect: pass.
- Runtime inspect: pass, `imported: true`.
- Runtime facade: pass.
- Bundled fallback dependency: not required for PLUR1BUS in this smoke.

Runtime inspect reported:

- `kind: "extension"`
- `commands: ["plur1bus"]`
- `hookCount: 4`
- typed hooks: `agent_end`, `before_prompt_build`, `gateway_start`, `gateway_stop`
- diagnostics: none

## OPENCLAW_HOME Non-root Isolation

Beta3 gives `OPENCLAW_HOME` precedence over `HOME`/`USERPROFILE`, so every OpenClaw command was run with all three explicitly isolated:

- User: `kimi`
- UID/GID: `1000/1000`
- `HOME`: `/tmp/openclaw-beta3-nonroot-d9S9Px/home`
- `USERPROFILE`: `/tmp/openclaw-beta3-nonroot-d9S9Px/home`
- `OPENCLAW_HOME`: `/tmp/openclaw-beta3-nonroot-d9S9Px/home/.openclaw`
- Prefix: `/tmp/openclaw-beta3-nonroot-d9S9Px/prefix`
- `OPENCLAW_ALLOW_ROOT`: unset
- OpenClaw version: `OpenClaw 2026.5.12-beta.3 (cc46ca9)`

No OpenClaw command was run as root for the smoke. The counted testbed did not write to `/root/.openclaw`, `/usr/local`, or `/opt`. Root/system-path escape scan in the isolated OpenClaw home returned no hits.

OpenClaw created profile/workspace paths below the isolated base, including nested `.openclaw` paths under `OPENCLAW_HOME`. This is unusual-looking but still contained inside `/tmp/openclaw-beta3-nonroot-d9S9Px`.

## Manifest and Runtime Entry

`openclaw.plugin.json` is used for discovery/config/contracts. It contains:

- `id: memory-lancedb-namespaced`
- `version: 3.0.0-beta.2`
- `contracts.tools`: `knowledge_update`, `memory_forget`, `memory_recall`, `memory_store`
- config schema including embedding, baseDbPath, hooks, neo mode, reranker, merging, Schicht 15, and GC surfaces.

The runtime entry is not in the manifest. It is declared in `package.json`:

```json
"openclaw": {
  "extensions": [
    "./index.js"
  ]
}
```

Beta3 accepted this declaration. No package/manifest fix is required.

## Sibling Dependency Testbed

The non-root smoke copied the whole PLUR1BUS repo into `/tmp` instead of linking only `memory-lancedb-namespaced`, because `index.js` loads LanceDB/OpenAI from the sibling plugin:

- `../memory-lancedb-stock/node_modules/@lancedb/lancedb/...`
- `../memory-lancedb-stock/node_modules/openai/...`

`npm install --prefix "$BASE/src/openclaw-memory-system/extensions/memory-lancedb-stock"` was run under the non-root user before runtime inspect. Missing sibling deps would be a testbed error, not an OpenClaw beta3 breaking change.

## Verification

Static/unit/package gates:

- `node --check extensions/memory-lancedb-namespaced/index.js`: pass
- `node --check extensions/memory-lancedb-namespaced/lib/neo-arch.js`: pass
- `bash -n scripts/install-memory-system.sh`: pass
- `node --test extensions/memory-lancedb-namespaced/__tests__/*.test.js`: pass, 9/9
- `npm pack ./extensions/memory-lancedb-namespaced`: pass, `memory-lancedb-namespaced-3.0.0-beta.2.tgz`, shasum `ff857c53953dc85fd8bf07688d64c03394739f08`

Non-root OpenClaw gates:

- Exact beta3 install via `install-cli.sh --prefix ... --version 2026.5.12-beta.3 --no-onboard --json`: pass
- `plugins doctor` before install: pass
- `plugins install --link`: pass for linked plugin registration path
- `plugins inspect memory-lancedb-namespaced --json`: pass
- `plugins inspect memory-lancedb-namespaced --json --runtime`: pass
- `plugins doctor` after config/runtime load: pass

Functional memory tool gates:

- `memory_store`, `memory_recall`, `memory_forget`, `knowledge_update`: blocked, no real embedding key or local embedding stub in this isolated run.
- `baseDbPath` was explicitly set to `/tmp/openclaw-beta3-nonroot-d9S9Px/home/.openclaw/memory/lancedb-namespaced`.

## Breaking-Risk Assessment

No beta3-only breaking change was found for PLUR1BUS v3.

The highest-risk areas remain smoke-required rather than code-change-required:

- linked-plugin runtime facade and SDK alias loading
- plugin inspector advisory behavior around suspicious code patterns
- explicit `OPENCLAW_HOME` isolation in tests and future install docs
- provider/gateway token cap and stream diagnostics, if future PLUR1BUS features call model/provider APIs directly
- per-sender tool policies, if PLUR1BUS later needs sender-aware exposure

## Integration Backlog

| OpenClaw surface | Value for PLUR1BUS | Risk | Recommendation |
| --- | --- | --- | --- |
| `session_end` shutdown/restart | Cleaner end-of-session journal flush and graceful state compaction. | Medium: can duplicate `agent_end` capture if wired naively. | Backlog, design dedupe first. |
| `cron.get` | Better read-only heartbeat/status diagnostics for memory GC and maintenance. | Low. | Backlog. |
| Dynamic/per-sender tool policies | Hide or narrow memory tools by sender/session context. | Medium: policy mistakes can make memory tools disappear. | Backlog after policy tests exist. |
| Plugin SDK session actions / scheduled turns | Could drive deferred memory consolidation or review loops. | Medium/high: behavior promotion risk. | Backlog, no compatibility-branch integration. |
| Active model metadata | Store provenance for memories with model/provider context. | Low/medium. | Backlog. |
| Linked plugin runtime facade fix | Keeps dev/test linked plugin path reliable. | Low. | Use as required smoke gate; no PLUR1BUS code change. |
