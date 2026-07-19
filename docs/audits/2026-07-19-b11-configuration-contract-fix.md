# B11 Configuration Contract Fix Receipt

Date: 2026-07-19
Batch: B11 configuration-contract core
Branch: `fix/high-mid-audit-findings`
Fix base: `c588717e2f6e6e108b1a43a659a32f49d4eae723`
Findings: FA-01, FA-02, FA-09, FA-10, FE-ADD-01, the safe B11
portion of FA-06, and the load-time portion of BUG-ADD-09 / FE-ADD-07

## Outcome and scope

B11 replaces implicit Full Experience activation with one manifest-derived,
strict, path-aware effective-configuration boundary. Runtime registration,
explicit setup profiles, installer planning, installer persistence, command
copy, and copyable documentation now agree on the same defaults and safety
gates. Missing config follows `openclaw.plugin.json`; only explicit Safe or
Recommended selection writes a profile.

This receipt deliberately does **not** claim complete FA-06 closure. It does
not expose `namespaces`, `retroactiveInterference`, or `quietHours`.
Namespaces remains B12 work. Retroactive interference remains schema-
unreachable until B13 proves ownership-scoped candidate mutation. The low
formatter-cache growth issue is also outside this batch.

## Closure matrix

| Finding / row | B11 result |
| --- | --- |
| FA-01 | Closed: missing config cannot enable advanced Full Experience features; explicit Recommended remains functional. |
| FA-02 | Closed: Safe is schema-valid, keeps core capture/recall available, and enforces every listed mutator/write gate off. |
| FA-09 | Closed: `recall.decisionTrace` is a strict object; four live keys are typed; compatibility flags are fixed to `false`; the unused runtime persistence local is removed. |
| FA-10 | Closed for B11-owned config/setup/docs agreement; later B12 recall-option wiring is not claimed. |
| FE-ADD-01 | Closed for preserve/update behavior: entry-level disable, providers, paths, runtime values, opt-outs, rollback data, memory slot, and legacy backend state survive. No backend/data migration is claimed. |
| BUG-ADD-09 / FE-ADD-07 share | Load-time timezone/direct-hour portion closed with exact paths and pre-registration rejection. Joint FE-ADD-07 closure also requires the B10 wizard receipt. |
| FA-06 safe rows | Closed for reply outcomes, dream narrative, reminders, embedding batch size, language/timezone compatibility, Meta-Cognition thresholds, fixed merge invariants, strict Decision Trace, review aliases, and hooks placement. |
| FA-06 `namespaces` | Open; B12 owns schema, containment, and read/write-role validation. |
| FA-06 `retroactiveInterference` | Open and intentionally unreachable; B13 must prove immutable ownership context before schema exposure. |

## Source-to-sink closure

### One effective-config truth

The former defect had three activation paths:

```text
missing runtime / profile / installer config
  -> applyFullExperiencePolicy()
  -> missing advanced flags become true or apply-oriented
  -> providers, merge sinks, jobs, reviews, and bridge consume rewritten cfg
```

`lib/setup/config-contract.js` now loads `openclaw.plugin.json` relative to
`import.meta.url`, recursively validates and materializes only manifest
defaults, clones inputs, normalizes controlled review aliases, validates all
supported timezones, and returns a private deeply frozen effective value.
`register(api)` invokes this seam before its first API/path/filesystem action.

The validator covers the manifest constructs used in this repository:
string/union types, strict objects, required properties, schema-valued or false
`additionalProperties`, arrays/items, enum, const, and numeric/string/array
bounds. Plain-object checks reject arrays and non-objects, finite-number checks
reject `NaN`, and prototype-shaped JSON keys are rejected with complete paths.

### Explicit profiles and installer preservation

Safe and Recommended are schema-valid explicit profiles. Safe enforces the
listed non-mutating values after merging. Recommended preserves feature
opt-outs and custom provider/path/runtime values while reasserting mandatory
merge, Obsidian, semantic-graph, vault-confirmation, and pending-review safety
gates on repeat application. Both record `setupProfile` and
`featuresConfirmedAt`.

Installer `preserve` is clone-only: it does not activate the entry or persist
effective defaults. Explicit `safe` and `recommended` enable/create the entry
and apply the corresponding profile. Implicit `fresh`, `force`, and
`enable-all` helper modes reject. The shell defaults new interactive installs
to Safe, existing installs to preserve, and treats `--accept-defaults` as the
documented explicit Recommended selection.

Legacy `config.hooks` migrates to entry-level `hooks` only during explicit
profile application and never overwrites an explicit entry-level value.
Legacy review aliases become nested effective values only when the nested path
is absent; conflicting explicit aliases reject with both complete paths.

### Time, Decision Trace, merge, and legacy provider boundaries

All eight supported timezone paths reject explicit invalid or whitespace
values before registration; absent, `null`, and empty string preserve local
time behavior. Direct hour pairs require both integer leaves in `[0, 23]` and
report the exact failing leaf. No quiet-hours schema was added.

Decision Trace now exposes exactly four live settings plus two compatibility
flags fixed to false. Mandatory merge properties are `const` safety invariants;
the unwired public `maxAutoApplyPerRun` option was removed instead of being
advertised without sink enforcement. Existing merge owning tests explicitly
turn on `autoApply`, preserving both legitimate merge paths.

The effective seam makes a disabled reranker explicit before the existing
empty-store legacy provider migration runs. Its old condition treated provider
`disabled` as migration-eligible and re-enabled reranking. The migration now
short-circuits on explicit `enabled:false`, while an eligible missing embedding
still migrates locally. The deploy-integrity manifest includes the new direct
runtime dependency `lib/setup/config-contract.js`.

## Causal TDD evidence

The implementation report at `/tmp/plur1bus-sdd/b11-report.md` records the
complete observed outputs for the original eight RED groups. They established:

- invalid timezone registration began instead of rejecting;
- empty config enabled reranking/merge auto-apply;
- Decision Trace was not structurally strict;
- Safe emitted invalid `mode:"dry-run"` and was refilled with advanced flags;
- installer preserve activated/rewrote entries;
- both shell patch bodies disabled the legacy backend;
- the canonical copied documentation was invalid; and
- the manifest advertised an unwired merge run cap.

The corresponding initial GREEN waves passed seam/time/config 15/15, 14/14,
and 131/131; profile/installer 41/41; runtime/docs/shell/migration 242/242; and
the B10 preservation gate 49/49.

Resume review added three causal cycles:

```text
$ node --test --test-concurrency=1 \
    --test-name-pattern="repeated Recommended restores" \
    tests/smoke-feature-profiles.test.js
RED: tests 1; pass 0; fail 1
Cause: existing merging.autoApply remained true through mergeMissing.

$ node --test --test-concurrency=1 \
    --test-name-pattern="repeated Recommended restores" \
    tests/smoke-feature-profiles.test.js
GREEN: tests 1; pass 1; fail 0

$ node --test --test-concurrency=1 \
    tests/smoke-feature-profiles.test.js tests/installer-config.test.js
GREEN: tests 43; pass 43; fail 0
```

The direct registered setup-command control then exposed a second missing
positive path: manifest-complete profiles include `null` values, and the
post-write status renderer dereferenced `value.enabled` when `value` was null.
Before the one-condition production fix, `tests/plur1bus-start-flow.test.js`
reported 4 tests, 3 pass, 1 fail with a `TypeError` at the real command
renderer. After the fix it passed 4/4 and proved argument-less listing is
byte-stable while explicit Safe and Recommended preserve provider/path/
rollback/opt-out state.

The final direct-caller review then exposed a canonical-writer bypass:
`/enable morningReview` and `/enable eveningReview` still wrote accepted
legacy aliases. With canonical profile values already present, that could
create a conflicting pair rejected by the next effective-config load. The
focused test first failed 0/1 because the canonical nested value remained
false, then passed 1/1 after the whitelist paths were changed; the full toggle
file passed 9/9.

## Positive-path and bypass review

- Empty config yields manifest defaults and preserves every B3 runtime/cache
  field, including recall cache TTL `120000` and max entries `128`.
- Unknown top-level/nested keys, arrays-as-objects, `null` objects, non-finite
  numbers, enum/const violations, and `__proto__`/`prototype`/`constructor`
  shaped JSON reject. Valid objects remain cloned and unmodified.
- `UTC`, `Europe/Berlin`, and absent/`null`/empty timezone inputs pass;
  `Not/AZone`, whitespace, wrong type, every nested review timezone, and direct
  `-1`, `24`, `1.5`, `"22"`, or half-pairs reject at exact paths. A `22..8`
  wrap-around remains functional.
- Equal review aliases normalize privately; conflicting aliases identify both
  exact paths. Legacy hooks migrate only on explicit profile writes and never
  replace entry-level hooks.
- Missing, enabled, and disabled entries; missing config; explicit nested
  false; provider/path/runtime values; rollback state; and legacy backend state
  are covered. Preserve planning may materialize an effective view but leaves
  persisted input unchanged.
- Registered `/plur1bus setup` only lists profiles and leaves the config bytes
  untouched. Registered `setup safe` and `setup recommended` exercise the real
  authorized lock/read/validate/write/render path. Repeated Recommended resets
  mandatory gates but keeps feature opt-outs.
- `/enable morningReview` and `/enable eveningReview` write the canonical
  nested review paths, so toggling a profiled config cannot create a conflicting
  legacy alias pair.
- Vault discovery is display-only and never clears confirmation requirements.
- Static shell fixtures cover both local JQ and remote Node patch bodies, the
  existing memory slot, and dry-run's explicit no-backend-switch statement.
- The model-tool and bridge/store merge owning fixtures explicitly opt into
  merge auto-apply, so removing its unsafe implicit default does not hide the
  legitimate paths.
- The B10 wizard/i18n files are untouched and its preservation suite is a
  mandatory final gate.

## Changed files

Production/config:

- `index.js`
- `lib/setup/config-contract.js`
- `lib/setup/feature-profiles.js`
- `lib/time-window.js`
- `lib/providers/legacy-provider-migration.js`
- `lib/telegram-commands/feature-toggle.js`
- `openclaw.plugin.json`
- `scripts/lib/installer-config.mjs`
- `scripts/lib/deploy-integrity.mjs`
- `scripts/install-memory-system.sh`

Tests:

- `tests/config-contract.test.js`
- `tests/runtime-config-contract.test.js`
- `tests/config-docs-contract.test.js`
- `tests/config-audit.test.js`
- `tests/smoke-feature-profiles.test.js`
- `tests/smoke-recommended-mode.test.js`
- `tests/installer-config.test.js`
- `tests/installer-stub-guard.test.js`
- `tests/time-window.test.js`
- `tests/plur1bus-start-flow.test.js`
- `tests/upgrade-v6.test.js`
- `test/feature-toggle.test.js`
- `tests/legacy-provider-migration.test.js`
- merge/lease owning fixtures adjusted only to remove forbidden config or make
  formerly implicit merge auto-apply explicit

Documentation:

- `README.md`
- `docs/configuration.md`
- `docs/recall-architecture.md`
- this receipt

## Final verification

Fresh post-resume completion evidence:

```text
$ node --test --test-concurrency=1 <ten B11 focused files>
tests 239; suites 28; pass 239; fail 0; skipped 0
duration_ms 3283.200202; exit 0

$ node --test --test-concurrency=1 <five B10 preservation files>
tests 49; suites 5; pass 49; fail 0; skipped 0
duration_ms 1485.641954; exit 0

$ node --test --test-concurrency=1 <nine profile/provider/deploy/merge/lease owning files>
tests 80; suites 21; pass 79; fail 0; skipped 1
duration_ms 122609.796075; exit 0

$ node --check index.js
$ node --check lib/setup/config-contract.js
$ node --check lib/setup/feature-profiles.js
$ node --check lib/telegram-commands/feature-toggle.js
$ node --check lib/time-window.js
$ node --check scripts/lib/installer-config.mjs
$ bash -n scripts/install-memory-system.sh
$ npm run lint
$ git diff --check
all exit 0

$ node --test --test-concurrency=1 tests/*.test.js test/*.test.js
tests 2678; suites 512; pass 2677; fail 0; cancelled 0; skipped 1
todo 0; duration_ms 363884.914782; exit 0
```

The single skip is the repository's environment-dependent non-writable
workspace permission fixture. The real nested-child symlink test passed inside
the serial run, so no sandbox-EPERM fallback was required.

## Remaining uncertainty and non-claims

- FA-06 remains partial until B12 and B13 close the two explicit rows above.
- No namespace, retroactive-interference, ACL/share, cron-provisioning,
  dependency, schema/data migration, or provider-wizard/i18n implementation is
  included.
- Preserve mode intentionally does not normalize the raw file. Compatibility
  aliases and defaults may therefore differ between raw bytes and the private
  effective view while runtime semantics stay canonical.
- This batch does not claim a legacy backend or data migration; it prevents an
  unproven switch and preserves rollback state.
