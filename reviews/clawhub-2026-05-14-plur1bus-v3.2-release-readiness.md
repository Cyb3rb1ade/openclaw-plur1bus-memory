# ClawHub Release Readiness: PLUR1BUS v3.2.0-beta.1

Date: 2026-05-14

Verdict: **ready-with-caveats**. No real publish was attempted.

## Publisher and Package Identity

- `clawhub whoami`: `Cyb3rb1ade`
- GitHub remote: `git@github.com:Cyb3rb1ade/openclaw-plur1bus-memory.git`
- controlled scope: `@cyb3rb1ade`
- package name set to: `@cyb3rb1ade/plur1bus-memory`
- previous package name: `memory-lancedb-namespaced`

Explicit non-targets:

- `@plur-ai/claw`: not ours, not used
- `clawhub:plur1bus`: not ours, not used

The OpenClaw plugin ID remains `memory-lancedb-namespaced`. Package name and
OpenClaw plugin ID are deliberately separate because existing profiles, configs,
and tests refer to the internal plugin ID. Any future plugin ID rename needs a
migration plan.

## Metadata

`extensions/memory-lancedb-namespaced/package.json` now declares:

```json
{
  "name": "@cyb3rb1ade/plur1bus-memory",
  "version": "3.2.0-beta.1",
  "openclaw": {
    "extensions": ["./index.js"],
    "compat": {
      "pluginApi": ">=2026.5.12-beta.6",
      "minGatewayVersion": "2026.5.12-beta.6"
    },
    "build": {
      "openclawVersion": "2026.5.12-beta.8",
      "pluginSdkVersion": "2026.5.12-beta.8"
    }
  }
}
```

ClawHub CLI `package pack` and `package publish --dry-run` accepted these fields.

Manifest checks:

- `openclaw.plugin.json` version: `3.2.0-beta.1`
- `id`: `memory-lancedb-namespaced`
- no `kind: "memory"`
- no `registerMemoryCapability` activation
- `contracts.tools`: `memory_store`, `memory_recall`, `memory_forget`, `knowledge_update`
- `contracts.memoryEmbeddingProviders`: `plur1bus-openai`, `plur1bus-openai-compatible`, `plur1bus-e5-small`

## README

The package README no longer points to `@plur-ai/claw` or unscoped
`clawhub:plur1bus`.

It documents the concrete controlled-scope install command:

```bash
openclaw plugins install clawhub:@cyb3rb1ade/plur1bus-memory
```

It also documents:

- PLUR1BUS remains augment
- `memory-core` remains Slot-Owner
- minimum OpenClaw version `2026.5.12-beta.6`
- `hooks.allowConversationAccess=true` for Auto-Capture
- OpenAI `text-embedding-3-large` as recommended remote embedding path
- OpenAI-compatible embeddings
- `plur1bus-e5-small` as experimental
- Cohere and disabled reranker modes
- no model downloads at inspect/register
- no secret resolution at inspect/register
- local E5/GTE remains experimental/blocked pending real local smoke

## Tarball

`npm pack ./extensions/memory-lancedb-namespaced` produced:

- `cyb3rb1ade-plur1bus-memory-3.2.0-beta.1.tgz`
- package name: `@cyb3rb1ade/plur1bus-memory`
- version: `3.2.0-beta.1`
- total files: 18

Allowed content present:

- `package/package.json`
- `package/openclaw.plugin.json`
- `package/index.js`
- `package/README.md`
- `package/lib/`
- `package/lib/providers/openclaw-memory-embedding-adapters.js`

Forbidden content absent:

- model caches
- `.env`
- API keys
- `/root` paths
- old review artifacts
- test tempfiles

ClawPack:

- `clawhub package pack` produced a valid ClawPack tarball
- size: `50252`
- sha256: `edeb36dc793161aed4a9999fcc72c2c58e57b4374a0f1d9e53e2e4fe006f448b`
- local generated pack artifact was removed after the dry-run

## Beta8 Smoke

Fresh isolated base:

- base: `/tmp/plur1bus-clawhub-beta8-1faPmT`
- OpenClaw installed through `install-cli.sh`
- target: `2026.5.12-beta.8`
- version: `OpenClaw 2026.5.12-beta.8 (097daf9)`
- no bare `openclaw` lane commands
- all lane commands used `runuser -u kimi -- env ... "$BASE/prefix/bin/openclaw"`

Link lane:

- profile: `plur1bus-clawhub-v32-link`
- install: pass
- `plugins inspect --json`: pass
- `plugins inspect --json --runtime`: pass
- `plugins doctor`: pass
- runtime plugin kind: `extension`
- package name: `@cyb3rb1ade/plur1bus-memory`
- plugin ID: `memory-lancedb-namespaced`
- provider bridge visible in runtime inspect
- typed hooks: `agent_end`, `before_prompt_build`, `gateway_start`, `gateway_stop`

Managed npm-pack lane:

- profile: `plur1bus-clawhub-v32-tarball`
- install: pass
- install source: `npm-pack:/tmp/plur1bus-clawhub-beta8-1faPmT/artifacts/cyb3rb1ade-plur1bus-memory-3.2.0-beta.1.tgz`
- artifact kind: `npm-pack`
- `plugins inspect --json`: pass
- `plugins inspect --json --runtime`: pass
- `plugins doctor`: pass
- runtime plugin kind: `extension`
- package name: `@cyb3rb1ade/plur1bus-memory`
- plugin ID: `memory-lancedb-namespaced`
- provider bridge visible in runtime inspect
- `memory-core` remains `kind: "memory"` and `memorySlotSelected: true`

Visibility caveat:

- `capability embedding providers --json` still lists only OpenClaw core `local`
- PLUR1BUS provider bridge is visible through plugin runtime inspect

## ClawHub Dry-Run

Folder source dry-run:

- result: blocked by CLI source validation
- error: `Path must be a folder or ClawPack .tgz`

Normal npm tarball dry-run:

- result: blocked by CLI source validation
- error: `Path must be a folder or ClawPack .tgz`

ClawPack dry-run:

```bash
clawhub package publish <clawpack.tgz> \
  --family code-plugin \
  --source-repo Cyb3rb1ade/openclaw-plur1bus-memory \
  --source-commit 39cb9fe844897c6fa2ebcce400a3cfe50f2f9ea4 \
  --source-ref neo-arch-openclaw-current-compat \
  --source-path extensions/memory-lancedb-namespaced \
  --dry-run --json
```

Result: pass.

Dry-run output:

```json
{
  "source": "github:Cyb3rb1ade/openclaw-plur1bus-memory@neo-arch-openclaw-current-compat:extensions/memory-lancedb-namespaced",
  "name": "@cyb3rb1ade/plur1bus-memory",
  "displayName": "Memory (LanceDB, per-Agent)",
  "family": "code-plugin",
  "version": "3.2.0-beta.1",
  "commit": "39cb9fe844897c6fa2ebcce400a3cfe50f2f9ea4",
  "files": 18,
  "totalBytes": 50252
}
```

## Caveats Before Real Publish

- Do not publish without explicit release approval.
- Commit and push the package-name/readiness changes before a real publish; the
  dry-run source commit currently points to the previous committed branch head.
- Recreate the ClawPack from the committed tree before publish.
- Local E5/GTE remains experimental until real local model smoke passes.
- Capability CLI provider listing remains limited; runtime inspect is the
  provider bridge evidence.
