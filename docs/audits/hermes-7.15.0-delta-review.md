# Hermes 7.15.0 port — implementation checkpoint

Status: **NOT RELEASE READY**. Native dashboard work and final platform gates remain.
No production profile has been installed or migrated during this port.

## Immutable inputs

- Previous Hermes candidate: c793391d4d0c306dd1c90cee654eab108c7dd30c (7.12.70-hermes.0; based on upstream 7.12.69).
- Upstream target: 8c29aeab9e03691d3a07e31756b3f23addf9bba1 (v7.15.0).
- Isolated branch: codex/hermes-port-7.15.0.
- Original dirty checkout remains untouched.
- Upstream PR #175: https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory/pull/175
  Commit 139e0b60 preserves preambles and short statements during chunking.
  Four new tests failed on v7.15.0; all 48 focused tests passed after the fix.
  All six upstream CI checks passed. PR not merged into OpenClaw main.

## Native implementation so far

- Capture segmentation before embedding; whole/parts/both follow the upstream
  captureChunking and captureChunkingMode keys.
- Native lossless splitter preserves list markers, prefixes and short fragments.
  At most twenty parts; no additional LLM request.
- Original rows have empty chunkGroupId; children share one group.
  sourceTurnId binds the actual journal row.
- Child IDs and versioned split-mode snapshots survive queued retries.
  Relative TTL is anchored once to the admitted capture timestamp.
- Trust can only be downgraded from the parent; splitting cannot convert
  injected/assistant context into observed user evidence.
- Parent tombstones block every child, including parts-only mode.
- Additive sourceTurnId/chunkGroupId migration; corrections and legacy import
  retain grouping. Re-embedding already preserves source schemas.
- Per-agent/per-task internal model resolution maps native purposes to upstream
  features. Named alternate routes are self-contained; credentials are never
  inherited into another provider endpoint. Unknown routes fail closed.
- Existing encoding/decay PR #165 protections are now part of the upstream tag.

## Required next work — do not publish before completion

Checkpoint verification: 1,081 native/controls/distribution tests passed,
2 skipped, 446 subtests passed; the subsequently added .715 source-inventory
test also passed separately. All 112 focused upstream feature/chunking/dashboard
tests passed. JavaScript lint and git diff --check passed. These are source
checkpoint results, not final native UI or cross-platform package acceptance.

1. Complete native feature-model catalogue integration with Hermes host models,
   rather than requiring manually configured llmRouter.modelRoutes.
   Test provider/protocol changes, OAuth-only hosts, profile switches and caches.
2. Port dashboard feature toggles, operating decisions, storage mode,
   model matrix and Capacity & Runtime to Hermes web AND desktop surfaces.
   Reuse actor-bound previews, nonces, revision checks and atomic profile writes.
   Never display a switch that has no native runtime consumer.
3. Audit existing native GC semantics before exposing upstream capacity caps:
   native run_gc currently archives expired cards, not maxMemoryCount overflow.
   Do not label that setting effective until a safe native consumer exists.
4. Review whole/child automatic-merge interactions and crash recovery after
   canonical insert but before all domain materializations; current stable-ID
   retry coverage exercises partial embedding failure.
5. Complete a feature-by-feature native contract matrix, including historical
   Hermes-only controls, profile bootstrap and install behavior.
6. Run full JS/native/UI/security gates on the final tree; build and verify
   macOS ARM, Windows x64/ARM and Linux x64/ARM packages. Signing/notarization and
   registry/GitHub publication are separate from source integration.

## Reviewed upstream commit inventory (15 non-merge commits)

- 8c29aeab 7.15.0: Schalter und Entscheidungen im Reiter, Kapazitaets-Panel
- 1a102d33 Panel-Test nutzt den aufraeumenden Tempdir-Helfer
- 6c8d8e9a Panel "Capacity & Runtime": Fuellstand, letzter GC-Lauf, Druck, Grenzen
- 1d805ff8 Projektionstests: Karte ohne Feature-Schalter, Opt-in-Vorgaben zulassen
- d65ae228 Schalter und Betriebsentscheidungen auf den Feature-Karten
- e963c28c 7.14.0: Modell-Matrix, Agentenstandard, Speicherweise im Reiter
- f2c5b717 Modell-Matrix mit Agentenstandard, Agenten aus agents.entries
- ab6c2ffc Speicherweise im Dashboard waehlbar machen
- 25676d4f Add per-agent model controls for PLUR1BUS LLM features
- 9858b861 7.13.0: Aufteilung wirksam machen, Ursprungszeile behalten, Modus waehlbar
- 38d1fd66 Node-Untergrenzen-Test nachgezogen statt umgangen
- 1e568ada Node 24 als Untergrenze, passend zum Host
- 23e7da41 7.12.70: README auf den Stand gebracht, Abschalter ins Schema
- 1e5753b5 7.12.70: mehrteilige Nachrichten als mehrere Vektoren
- fab1c4e5 fix(encoding): preserve decay clock and explicit core classification

## Complete upstream file inventory (38 paths)

All upstream JS runtime/UI changes are merged; this does not imply that their
native Hermes counterparts are implemented. Package versions use the Hermes suffix.

- `.github/workflows/ci.yml`
- `.github/workflows/macos-portability.yml`
- `.github/workflows/macos-scoped-embedding.yml`
- `CHANGELOG.md`
- `README.md`
- `docs/configuration.md`
- `index.js`
- `lib/control-plane-projection.js`
- `lib/dashboard-operations.js`
- `lib/dashboard-settings.js`
- `lib/db-adapter.js`
- `lib/encoding-llm.js`
- `lib/feature-definitions.js`
- `lib/featureModels.js`
- `lib/llm-router.js`
- `lib/memory-chunking.js`
- `lib/safe-update.js`
- `lib/setup/control-ui-plugin-runtime.js`
- `lib/setup/control-ui-write.js`
- `openclaw.plugin.json`
- `package-lock.json`
- `package.json`
- `scripts/lib/deploy-integrity.mjs`
- `tests/capture-chunking-switch.test.js`
- `tests/capture-chunking.test.js`
- `tests/control-plane-projection.test.js`
- `tests/control-ui-plugin-runtime.test.js`
- `tests/dashboard-operations.test.js`
- `tests/dashboard-settings.test.js`
- `tests/emotion-refine-cron.test.js`
- `tests/encoding-refine-preservation.test.js`
- `tests/featureModelSelection.test.js`
- `tests/memory-chunking.test.js`
- `tests/node-runtime-floor.test.js`
- `tests/openclaw-default-llm-callers.test.js`
- `tests/openclaw-default-llm-contract.test.js`
- `tests/openclaw-default-llm-runtime.test.js`
- `tests/release-750-compat.test.js`
