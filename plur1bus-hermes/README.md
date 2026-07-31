# PLUR1BUS Hermes Adapter (Python)

This directory contains the installable Hermes memory-provider package for PLUR1BUS.

Current scope in this milestone:

- A Hermes `MemoryProvider` subclass with the lifecycle hooks used by Hermes 0.19+.
- Shared validation helpers that mirror critical OpenClaw-side constraints.
- A deterministic migration entrypoint for dry-run inventory/manifest generation.
- A controls-facing shared runtime container bridge for non-blocking service reuse.

It intentionally runs without a Node.js dependency and is designed to run
inside Hermes' plugin process. Install it with `scripts/install-hermes-plugins.sh`;
the provider is copied to `~/.hermes/plugins/plur1bus/` and controls to
`~/.hermes/plugins/plur1bus-controls/`.

The adapter is installable and lifecycle-correct, but the full PLUR1BUS domain
parity (LanceDB recall/capture, graph, Obsidian, dreaming, and migration copy)
is still tracked in the migration plan and must not be used as a production
cutover yet.

### Credential and local-model setup

Run `scripts/install-hermes-plugins.sh`. When Hermes is available, it starts
`hermes memory setup`; otherwise it prints the exact command. Hermes writes the
optional remote keys to `$HERMES_HOME/.env` as `PLUR1BUS_EMBEDDING_API_KEY` and
`PLUR1BUS_RERANKER_API_KEY`. They are never stored in `config.json`.

The setup defaults to local `intfloat/multilingual-e5-base` embeddings (768
dimensions) and local `BAAI/bge-reranker-v2-m3` reranking. Remote OpenAI-
compatible embeddings and Cohere reranking remain selectable. Both have a
local-model failure fallback: `intfloat/multilingual-e5-base` for embeddings
and `BAAI/bge-reranker-v2-m3` for reranking. Any embedding fallback must use
the same vector dimension as its primary backend.

At completion the installer sets `memory.provider: plur1bus`, disables Hermes'
built-in `MEMORY.md` and `USER.md` injection, and enables `plur1bus-controls`.

If Hermes uses a virtual-environment interpreter, export
`HERMES_PYTHON=/path/to/that/python` before running the installer so its runtime
and PLUR1BUS dependencies are installed into the same environment.

### Package entrypoints

- `plur1bus-hermes` – lightweight CLI wrapper for status/help.
- `plur1bus-hermes-migrate` – migration command scaffold.

For full parity features, refer to `docs/superpowers/plans/2026-07-25-plur1bus-hermes-migration.md`.
