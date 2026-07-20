# B11 Configuration Contract Fix Receipt

Date: 2026-07-19
Batch: B11 configuration-contract core
Branch: `fix/high-mid-audit-findings`
Fix base: `c588717e2f6e6e108b1a43a659a32f49d4eae723`
Follow-up correction: 2026-07-20, R1-R5, base
`0a63a2de23904ec7561115f52a179d33bd987c00`
R5 review correction: 2026-07-20, base
`923a91af65d0f6aad49bcd9568e283d641d2ac14`
OpenClaw-default LLM implementation follow-up: 2026-07-20, base
`cf01840ff91e43a1c4a59199823bc7e0e856e981`
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
opt-outs and custom provider/path/non-safety runtime values while reasserting
the fixed reranker timeout, mandatory merge invariants, Obsidian,
semantic-graph, vault-confirmation, and pending-review safety gates on repeat
application. Explicit Recommended alone repairs the two historical fixed merge
booleans before strict validation; ordinary validation continues to reject
them. Both profiles record `setupProfile` and `featuresConfirmedAt`.

Installer `preserve` is clone-only: it does not activate the entry or persist
effective defaults. Explicit `safe` and `recommended` enable/create the entry
and apply the corresponding profile. Implicit `fresh`, `force`, and
`enable-all` helper modes reject. The shell defaults new interactive installs
to Safe, existing installs to preserve, and treats `--accept-defaults` as the
documented explicit Recommended selection.

Legacy `config.hooks` migrates to entry-level `hooks` during compatibility-
aware writes and never overwrites an explicit entry-level value. Installer
preserve mode remains byte-stable. Fresh explicit profiles receive hook
defaults only for absent fields. Legacy review aliases become nested effective
values only when the nested path is absent; equal aliases collapse and
conflicting explicit aliases reject with both complete paths before a toggle
can write.

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
empty-store legacy provider migration runs. The migration now treats every
explicit provider selection as authoritative, including `disabled`, Cohere,
OpenAI, and OpenAI-compatible selections without inline credential fields.
Credential resolution and its normal errors remain provider-layer concerns.
Only genuinely provider-absent embedding/reranker config migrates locally, and
an explicit `enabled:false` reranker remains untouched. The deploy-integrity
manifest includes the direct runtime dependency
`lib/setup/config-contract.js`.

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

The original direct-caller review moved `/enable morningReview` and `/enable
eveningReview` to canonical paths, but did not normalize an already-present
legacy alias or reject a pre-existing conflict before mutation. The R1-R5
follow-up corrected that writer boundary: normalization and complete plugin-
config validation now happen inside the existing lock before the atomic write;
conflicts return a structured error and leave the file byte-identical.

### R1-R5 follow-up causal evidence

The correction report at `/tmp/plur1bus-sdd/b11-fix-report.md` records every
command and observed output. The causal totals were:

```text
Cycle 1 Recommended forced safety set:
RED  tests 1; pass 0; fail 1 (9999 !== 5000)
GREEN tests 2; pass 2; fail 0

Cycle 2 narrow historical merge repair:
RED  tests 1; pass 0; fail 1 (backupBeforeApply must equal true)
GREEN tests 1; pass 1; fail 0

Cycle 3 toggle normalize/validate/no-write:
RED  tests 2; pass 0; fail 2
GREEN tests 2; pass 2; fail 0; complete toggle file 11/11

Cycle 4 explicit provider authority:
RED  tests 4; pass 1; fail 3
GREEN tests 4; pass 4; fail 0

Cycle 5 helper-owned hook defaults and authoritative shell sinks:
RED/GREEN helper 0/1 then 1/1
RED/GREEN executable local+remote transforms 0/2 then 2/2

Cycle 6 manifest-derived enabled-default documentation contract:
RED  tests 1; pass 0; fail 1 ('true' !== 'false')
GREEN tests 1; pass 1; fail 0

R5 review correction, Emotion T3 model default/fallback:
RED  tests 1; pass 0; fail 1 ('"gpt-4o-mini"' !== '—')
GREEN tests 1; pass 1; fail 0
```

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
- `/enable morningReview` and `/enable eveningReview` normalize legacy-only
  aliases, collapse equal aliases, validate the complete plugin config, and
  reject conflicts without changing the file.
- Vault discovery is display-only and never clears confirmation requirements.
- Executable tests extract and run the production local JQ heredoc and remote
  Node body. Both persist the helper-returned entry directly, preserve explicit
  and migrated hook values, the existing memory slot, enabled legacy backend,
  and unrelated root state. The local branch consumes the same tested JQ
  program; the dry-run text describes direct helper persistence and preserved
  explicit hooks.
- The model-tool and bridge/store merge owning fixtures explicitly opt into
  merge auto-apply, so removing its unsafe implicit default does not hide the
  legitimate paths.
- The earlier R5 docs-only Emotion T3 resolution is superseded by the
  implemented runtime contract below. An absent `emotion.t3.model` now uses
  the effective OpenClaw agent model and never inherits `merging.model` or a
  named PLUR1BUS fallback. Explicit named examples remain examples, not
  default claims.
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

Follow-up correction files were confined to the brief's allowlist:

- `lib/setup/feature-profiles.js`
- `lib/telegram-commands/feature-toggle.js`
- `lib/providers/legacy-provider-migration.js`
- `scripts/lib/installer-config.mjs`
- `scripts/install-memory-system.sh`
- `docs/configuration.md`
- `tests/smoke-feature-profiles.test.js`
- `tests/installer-config.test.js`
- `tests/plur1bus-start-flow.test.js`
- `test/feature-toggle.test.js`
- `tests/legacy-provider-migration.test.js`
- `tests/upgrade-v6.test.js`
- `tests/config-docs-contract.test.js`
- this receipt

## Final verification

Authoritative R1-R5 follow-up completion evidence:

```text
$ node --test --test-concurrency=1 <seven B11 R1-R5 focused files>
tests 93; suites 11; pass 93; fail 0; skipped 0
duration_ms 4129.158593; exit 0

$ node --test --test-concurrency=1 <eight config/runtime preservation files>
tests 187; suites 22; pass 187; fail 0; skipped 0
duration_ms 2018.488509; exit 0

$ node --check lib/setup/feature-profiles.js
$ node --check lib/telegram-commands/feature-toggle.js
$ node --check lib/providers/legacy-provider-migration.js
$ node --check scripts/lib/installer-config.mjs
$ bash -n scripts/install-memory-system.sh
$ npm run lint
$ git diff --check
all exit 0

$ node --test --test-concurrency=1 tests/*.test.js test/*.test.js
tests 2689; suites 512; pass 2688; fail 0; cancelled 0; skipped 1
todo 0; duration_ms 366571.560265; exit 0
```

The single skip is the repository's environment-dependent non-writable
workspace permission fixture. The real nested-child symlink test passed inside
the serial run, so no sandbox-EPERM fallback was required.

R5 review-correction verification:

```text
$ node --test --test-isolation=none --test-concurrency=1 \
    --test-name-pattern='keeps published safety-sensitive defaults aligned with the manifest' \
    tests/config-docs-contract.test.js
tests 1; suites 1; pass 1; fail 0; skipped 0; exit 0

$ node --test --test-concurrency=1 tests/config-docs-contract.test.js
tests 3; suites 1; pass 3; fail 0; skipped 0; exit 0

$ node --test --test-concurrency=1 <eight config/runtime preservation files>
tests 187; suites 22; pass 187; fail 0; skipped 0; exit 0

$ npm run lint
$ git diff --check
both exit 0
```

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

## OpenClaw-default LLM implementation follow-up (independent review pending)

The docs-only R5 model-default correction was not an adequate runtime closure:
runtime callers, feature ownership, installer output, trust requirements, and
deploy integrity also had to agree. The implementation series now present on
the isolated feature branch is:

```text
f0818ad docs: document LLM route kinds
b7ffa0d feat: use OpenClaw default for core LLM routes
03c4a62 fix: preserve LLM command context and critical no-op
10afa93 fix: warn when critical LLM runtime is unavailable
267fb71 feat: add LLM call context helper
211b18d fix: preserve existing LLM call context
5c8492b refactor: isolate feature LLM routes
cf01840 fix: remove hard-coded chat model defaults
Task 5  docs: align config with OpenClaw LLM defaults
```

Task 5 aligns every optional chat-model schema description without adding a
default; removes installer-forced Merging direct/model config and the copied
Schicht 1.5 route; leaves Safe, Recommended, and preserve free of implicit
models or entry-level LLM trust grants; documents the session/global/model
trust boundaries and the one-primary-attempt runtime behavior; and adds
`lib/llm-router.js` to deployment integrity.

Focused causal evidence:

```text
RED Task 5 contract/profile/deploy wave:
tests 63; pass 54; fail 9
Expected gaps: old Emotion fallback docs, missing schema descriptions,
missing route/trust/fail-closed docs, and missing router deploy entry.

RED installer wave:
tests 17; pass 16; fail 1
Expected gap: installer forced MERGING_* direct/model fields and copied them
into SCHICHT15_BLOCK.

GREEN exact focused Task 5 gate:
tests 72; suites 11; pass 72; fail 0; skipped 0

GREEN installer contract:
tests 17; suites 2; pass 17; fail 0; skipped 0

Task 5 lint and whitespace gates:
`npm run lint` exit 0; `git diff --check` exit 0
```

This receipt does **not** close the final B11 review. Task 6 still owns the
independent review, any remediation it finds, the authoritative full serial
gate, and the final closure decision. No Main/Remote/Primary integration is
claimed here.
