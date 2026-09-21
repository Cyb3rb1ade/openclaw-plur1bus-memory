# Hermes 7.15.3 — implementation checkpoint

Upstream: 51c49a52ae001ed6ea5440e625bbf77ae2115af7 (v7.15.3).
Hermes base: dc0ec09a (unfinished 7.15.0 port).
Status: **not release-ready**; no productive profile changed, no public release.

## Implemented and tested

- All upstream .15.1–.15.3 commits merged, including accepted PR #175.
- Native flashbulb score threshold 0.80; pending-only refinement still performs
  the one-time strengthening. Explicit agent core decisions retain precedence.
  The reverted .15.2 capture-only interpretation is not ported.
- Short fragments attach to the previous sentence. Existing queued version-one
  segmentation remains unchanged; new captures snapshot version two.
- Web and native desktop settings: storage mode, runtime-backed feature switches,
  task/agent model overrides from registered self-contained transport routes.
- Actor authentication, same-origin web controls, native transport separation,
  exact single-use review nonces, profile/scope binding, optimistic revisions,
  backups and atomic configuration writes.
- Saved settings are explicitly not presented as live gateway activation.
  Restart requirement remains visible.

## Verification

1,085 native/controls/distribution tests passed, 2 skipped, 444 subtests passed
before the final desktop extension (rerun required). Focused new boundary tests
passed. Existing desktop and web harnesses passed. Final HTTP, full JS,
cross-platform packaging and signing gates are still required.

## Remaining from the 7.15.0 port

See [previous full inventory](hermes-7.15.0-delta-review.md).
Host model catalogue/transport integration beyond registered native routes,
Capacity & Runtime with accurate gateway telemetry, native GC capacity-policy
parity, remaining operating-decision controls, materialization crash recovery
and final feature-matrix audit remain open. Do not call the package feature-complete.

## Additional upstream paths and commits

- `CHANGELOG.md`
- `README.md`
- `docs/configuration.md`
- `index.js`
- `lib/control-plane-projection.js`
- `lib/dashboard-settings.js`
- `lib/encoding-llm.js`
- `lib/memory-chunking.js`
- `lib/memory-dynamics.js`
- `lib/setup/control-ui-plugin-runtime.js`
- `lib/setup/control-ui-write.js`
- `openclaw.plugin.json`
- `package-lock.json`
- `package.json`
- `tests/chunking-content-preservation.test.js`
- `tests/dashboard-pending-and-views.test.js`
- `tests/emotion-refine-importance.test.js`
- `tests/featureModelSelection.test.js`
- `tests/flashbulb-wiring.test.js`
- `tests/memory-dynamics-halflife.test.js`
- `tests/release-750-compat.test.js`
- `51c49a52 7.15.3: Einbrennen im Refine-Pfad zurueck`
- `b909ca6b Schema-Test auf den Wortlaut von 7.15.3 nachziehen`
- `11aafba2 Einbrennen im Refine-Pfad zurueck — 7.15.2 beruhte auf einer Fehlannahme`
- `b1d742dd 7.15.2: Blitzlicht-Schwelle 0,80, Einbrennen nur beim Erfassen`
- `b56c8346 Phase 3: Blitzlicht-Schwelle auf 0,80, Einbrennen nur beim Erfassen`
- `1b7ac0c5 7.15.1: Dashboard sagt, was gespeichert und was wirklich laeuft`
- `fe5e9844 Dashboard sagt, was gespeichert und was wirklich am Laufen ist`
- `a8a1e4f9 Kurze Stuecke an den vorigen Satz haengen, nicht an den naechsten`
- `139e0b60 fix(capture): preserve prefixes and short statements when chunking`

