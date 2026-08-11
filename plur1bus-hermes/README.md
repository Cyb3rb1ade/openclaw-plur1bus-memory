# PLUR1BUS Hermes Adapter (Python)

This directory contains the installable Hermes memory-provider package for PLUR1BUS.

Current scope in this milestone:

- A Hermes `MemoryProvider` subclass with the lifecycle hooks used by Hermes 0.19+.
- Shared validation helpers that mirror critical OpenClaw-side constraints.
- A deterministic migration entrypoint for dry-run inventory/manifest generation.
- A controls-facing shared runtime container bridge for non-blocking service reuse.

It intentionally runs without a Node.js dependency and is designed to run
inside Hermes' plugin process. Install it with `scripts/install-hermes-plugins.sh`;
the provider and controls are copied below the selected Hermes home.

The adapter is installable and lifecycle-correct, but the full PLUR1BUS domain
parity (LanceDB recall/capture, graph, Obsidian, dreaming, and migration copy)
is still tracked in the migration plan and must not be used as a production
cutover yet.

### Retrieval configuration

The Hermes 0.3.0 release process will create `hermes-v0.3.0`. Once that tag
exists, install the release packages from it, or clone it and run
`scripts/install-hermes-plugins.sh` for the complete Hermes-plugin path. Its
pip step alone is not a complete installation: the full installer copies the
provider, controls, model-provider plugins, and helpers into the selected
Hermes home, installs provider dependencies with that instance's Python, and
configures the PLUR1BUS memory provider when the Hermes CLI is available. It
does not select or replace Hermes' chat provider or model settings.

For a new empty store, the installer makes a platform-aware Jina sidecar
recommendation. Jina is downloaded and enabled only after explicit acceptance
of its CC-BY-NC-4.0 license, and Hermes retrieval is configured only after the
sidecar smoke gate succeeds. Declining, unsupported platforms, a failed
download or smoke test, or an existing LanceDB store leaves local E5/BGE
active.

The installer resolves the Hermes home before writing anything. An explicit
`--hermes-home PATH` wins, followed by an exported `HERMES_HOME`. Otherwise it
discovers valid installations from `~/.hermes`, sibling `~/.hermes-*`
directories, `hermes config path`, macOS LaunchAgents, and Linux user-systemd
units. One installation is selected automatically; multiple installations get
a numbered TTY prompt. In noninteractive use (including no TTY), discovery is
not attempted: CI and multi-instance hosts must pass `--hermes-home` or export
`HERMES_HOME`, or the installer exits before writing. Profiles below one home
are not separate installations.
After selection, the installer uses that instance's
`hermes-agent/venv/bin/python` (or the portable `Scripts/python.exe` layout)
for package installation and passes it to the retrieval installer. An explicit
`HERMES_PYTHON` remains authoritative.

PLUR1BUS reads the active provider in `config.yaml` plus the active profile's
`profiles/<name>/config.yaml`. It uses a route only when that provider declares
the capability and gives that capability its own URL, model, and (for
embeddings) dimensions. Chat `base_url` and chat model are never reused for
retrieval. For example:

```yaml
providers:
  jina-router:
    retrieval:
      embeddings:
        base_url: http://127.0.0.1:18087/v1
        model: jina-embeddings-v5-text-small
        dimensions: 1024
        api_key: sidecar-local
      rerank:
        base_url: http://127.0.0.1:18087/v1
        model: jina-reranker-v3.5
        api_key: sidecar-local
```

If either capability is absent or incomplete, it independently falls back to
local `intfloat/multilingual-e5-base` embeddings (768 dimensions) and local
`BAAI/bge-reranker-v2-m3` reranking. A remote 768-dimensional embedding route
also gets that local model as a failure fallback; other dimensions cannot safely
fall back into a different LanceDB vector space.

Experts may retain a hand-managed plugin route by setting
`retrieval: {mode: plur1bus}` in `plugins/plur1bus/config.json`. Unmarked
legacy routes are ignored for new/empty stores. For a populated LanceDB store,
the configured legacy route is preserved; a central route is adopted only when
embedding model ID and dimensions match the existing vector space.

At completion the installer sets `memory.provider: plur1bus`, disables Hermes'
built-in `MEMORY.md` and `USER.md` injection, and enables `plur1bus-controls`.

If Hermes uses a virtual-environment interpreter, export
`HERMES_PYTHON=/path/to/that/python` before running the installer so its runtime
and PLUR1BUS dependencies are installed into the same environment.

### Package entrypoints

- `plur1bus-hermes` – lightweight CLI wrapper for status/help.
- `plur1bus-hermes-migrate` – migration command scaffold.

For full parity features, refer to `docs/superpowers/plans/2026-07-25-plur1bus-hermes-migration.md`.
