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
- Reviewed settings are sparse, profile-keyed overrides. Changing the default
  profile no longer changes other profiles through root-config inheritance.
  Unrelated nested defaults and later credential rotation remain inherited;
  explicitly supplied runtime configuration retains precedence.

## Verification

The earlier source checkpoint passed 1,085 native/controls/distribution tests,
2 skipped, 444 subtests. Dashboard HTTP tests: 31 passed. Desktop and web
harnesses passed. The full JavaScript run reported 4,981 passed, 76 skipped and
one README runtime-floor assertion failure; the missing sentence was restored
and both tests in that file subsequently passed. This is not a fresh all-green
full-suite claim. Lint, npm dependency audit and diff checks passed.

The c2235c67 macOS ARM candidate was signed and sandbox-installed; it predates
the profile-isolation fix and must not be published as the final artifact.
Final source, five-platform package and notarization gates remain separate.

Upstream bug PR #182 prevents saving a GC cap when authoritative memory counts
are missing or invalid. All six PR checks passed. It is not yet merged into
this Hermes candidate; the new native settings surface does not offer GC caps.

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
