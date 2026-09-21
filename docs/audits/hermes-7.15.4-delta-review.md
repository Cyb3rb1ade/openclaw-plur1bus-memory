# Hermes 7.15.4 — upstream delta and native adaptation

Upstream: `89148f9f604a27149094efbc7cd910a7d362a94a` (`v7.15.4`).
Hermes starting point: `fe604228` (unpublished 7.15.3 candidate).
Branch: `codex/hermes-port-7.15.4`. No productive profile changes or publication.

## Reviewed changes

| Upstream contract | Hermes handling |
| --- | --- |
| Unknown GC count rejects a capacity change before any write | Upstream JS retained verbatim. Native settings do not expose or accept `gc.maxMemoryCount`; no unsupported control added. |
| Largest count comes from GC-eligible stores, including hidden safe IDs | Original scanner and shared `isSafeAgentId` predicate retained verbatim. Native status remains restricted to the authorized profile/scope, not sibling enumeration. |
| Failed, incomplete or invalid counts remain unknown | Original projection retained. Native status rejects booleans, negative/fractional/non-numeric values and integers unsafe for browser JSON; it reports `None`, never fabricated zero. |
| Measured empty inventory is zero | Preserved upstream and covered for the native exact-table count. An unavailable native table remains unknown, not inferred empty. |
| Unknown count has its own refusal code and explanation | Original `denied_unknown_count` web action retained. Native GC-cap mutation is unsupported, so no misleading unused error route added. |

PR #182 was merged upstream on 2026-09-21 and is included via the tag. Its
original list-derived helper is superseded by the release's authoritative scan
field. The complete delta is four non-merge commits and fifteen files. Upstream
runtime and test files are byte-for-byte retained, except the established Hermes
version assertion in the release metadata test.

## Native compatibility and boundaries

Profile-keyed sparse settings, scheduled-job settings resolution, capture
segmentation/retries, trust/tombstone protections, provider switching and staged
re-embedding controls, desktop/web integration and platform installers remain.
Historical preservation gates and new .15.4 inventory tests check these boundaries.

This delta does not close the previous port's gaps: full Hermes model-catalogue
integration, native GC capacity policy, capacity/runtime telemetry, remaining
operating controls and the outstanding legacy/intra-journal crash review.
See [7.15.3 checkpoint](hermes-7.15.3-delta-review.md). Do not equate the bundled
OpenClaw JavaScript with reachable native Hermes features or claim full parity.

## Verification gate

Run native/controls/distribution and dashboard tests, complete JS suite, lint,
dependency audit, source-inventory checks and package inspection on this branch.
No coverage percentage is asserted. Platform CI and macOS signing/notarization
are separate gates. Building does not publish or install into a productive home.

## Complete upstream file inventory

- `CHANGELOG.md`
- `README.md`
- `index.js`
- `lib/control-plane-health.js`
- `lib/control-plane-projection.js`
- `lib/dashboard-settings.js`
- `lib/setup/control-ui-write.js`
- `lib/sql-safety.js`
- `openclaw.plugin.json`
- `package-lock.json`
- `package.json`
- `tests/control-plane-health.test.js`
- `tests/dashboard-gc-count-guard.test.js`
- `tests/dashboard-settings.test.js`
- `tests/release-750-compat.test.js`

## Complete upstream non-merge commit inventory

- `24986831` Waechter prueft gegen die Menge, die GC wirklich bereinigt
- `2e891514` 7.15.4: Gesundheitsscan buergt fuer den Agent-Bestand
- `9704a6c7` test(dashboard): require unavailable GC count to preserve existing cap
- `f8d6d5e9` fix(dashboard): refuse GC cap changes with unknown agent counts
