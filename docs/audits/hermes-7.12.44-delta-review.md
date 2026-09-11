# Hermes 7.12.44 pinned delta inventory

This is an inventory gate, not a native-port completion review. Its upstream
range is `v7.12.7..a3f48f28ac647e81c5260e8a1dbab7977bf9fb51`; its immutable
Hermes preservation baseline is
`c12ec2bba63d74ac8add8782ab6761472b4149c6` (`7.12.7-hermes.4`). The machine
readable source of truth is `hermes-7.12.44-delta.json`.

## Inventory result

- 37 non-merge upstream commits and all 90 changed upstream paths are captured
  from Git, rather than from release headings.
- Every commit remains deliberately `unreviewed` except `600aa2b` (the bounded
  Persona Voice directive projection): its reachable native call path and
  regression are recorded separately. A populated commit inventory is neither
  evidence of a reachable Python implementation nor a status upgrade.
- The pre-existing `FEATURES`, `COVERAGE_710`, and `COVERAGE_712` arrays are
  retained in their distinct source groups. Their source status/evidence is
  preserved and every audit row remains `unreviewed`.
- Preservation records hash every tracked baseline file under `distribution/`,
  `hermes-dashboard/`, `plur1bus-hermes/`, and `plur1bus-controls/`, plus
  `scripts/.npmignore` and the Hermes host/installer scripts. The regression
  reads bytes with `git show c12ec2b:path`; it does not trust a possibly
  changed worktree file as its own baseline.

## Concrete initial findings

These are verified gaps, not verified implementations:

| Upstream contract | Native evidence | Audit result |
| --- | --- | --- |
| 7.12.37 persona directive projection is not capped at 400 characters | `persona_voice.load_directive()` defaults to 400 and caps `max_chars` at 400 in `plur1bus-hermes/src/plur1bus_hermes/persona_voice.py`. | verified gap |
| 7.12.40/7.12.44 episode continuity and canonical identity work must accommodate shorter applicable episodes | `episode_narrative.MIN_TURNS = 5` and `enrich()` returns `None` below that threshold in `plur1bus-hermes/src/plur1bus_hermes/episode_narrative.py`. | verified gap |

## Native capture identity receipt (Task 1 follow-up)

Native automatic capture now mints a non-authorizing admission UUID and UTC
timestamp before executor submission.  A per-agent, UUID-addressed prepared
receipt binds the exact scope, session, source hashes, deterministic journal
and episode IDs, and bounded byte offsets/fingerprints.  Under the existing
writer lock, replay validates every already-indexed journal and episode target
before an append; a full append interrupted before its receipt update is
recognized at the recorded offset and completed without a history scan.

This is deliberately **partial** lifecycle parity.  A retry whose required
receipt is missing, truncated, or manually drifted fails closed and preserves
the evidence rather than claiming exactly-once recovery.  If another capture appends after an
interrupted prepared range, the original capture also fails closed; it never
scans or overwrites an unbounded JSONL tail.  The receipt stores source hashes,
not duplicate full user/assistant bodies.  Canonical memory, mood, reminder,
and other independent side effects remain outside this journal/episode claim.

Evidence: `test_turn_identity.py` injects append-then-interrupt recovery,
foreign-append fail-closed behavior, receipt timestamp reuse, and immutable
scope/session/source conflicts. `test_capture_retry.py` covers durable retry
identity, restart replay, malformed/foreign preservation, exhaustion, and a
numeric foreign retry-key collision during dead-lettering.

Round 2 exact verification:

```text
PYTHONPATH=plur1bus-hermes/src:plur1bus-controls/src:/Users/cyberblade/.hermes/hermes-agent \
  /Users/cyberblade/.hermes/hermes-agent/venv/bin/python -B -m unittest \
  plur1bus-hermes/tests/test_capture_retry.py plur1bus-hermes/tests/test_turn_identity.py \
  plur1bus-hermes/tests/test_domain.py plur1bus-hermes/tests/test_episode_narrative.py \
  plur1bus-hermes/tests/test_runtime_scheduler.py plur1bus-hermes/tests/test_runtime_provider.py
```

Result: 59 tests passed. The corresponding native discovery command with
`-m unittest discover -s plur1bus-hermes/tests -p 'test_*.py'` passed 565
tests. The latter is a native unit/integration gate only; it is not a host
lifecycle, guest-runtime, or universal crash-transaction claim.

Round 3 repeated the same focused command: 61 tests passed. Native discovery
repeated the same command with 567 tests passed. Its post-journal
`emotional-state.jsonl` failure regression deletes the receipt before throwing;
the runtime still persists the monotonic retry requirement set at the internal
receipt boundary, and replay fails closed without new journal/episode rows.
Conversely, a first receipt-prepare failure sets no requirement and has no
journal evidence, so its retry remains a first materialization.

Round 4 validates the receipt state/completion shape before accepting an
existing receipt, invoking its materialization callback, updating mood, or
rewriting the episode plan. Only an exact `preparing` descriptor with an empty
materialized journal and null episode plan/completion may advance to
`prepared`; `prepared` and `committed` receipts with a missing episode plan now
fail closed. The regression snapshots every fixture file and verifies that
both corrupt states leave the receipt, journal, episode, and mood files
byte-identical and do not signal the callback. The focused turn-identity,
capture-retry, and domain command passed 31 tests. This remains bounded receipt
recovery, not cross-file transactional capture or a claim about live Hermes
lifecycle behavior.

Round 5 moves complete episode-descriptor validation ahead of the journal
append loop. One shared preflight reconstructs the intentionally omitted
summary from hash-bound inputs, requires the snapshot fields, verifies identity
coherence, and checks the complete-record fingerprint and serialized byte
length for both `prepared` and `committed` receipts. The regression starts from
an actual post-preparation/pre-journal interruption and proves missing record,
length drift, fingerprint drift, and self-consistent identity drift all reject
with every fixture file byte-identical; a committed unused-snapshot mutation is
also rejected. The exact focused turn-identity, capture-retry, and domain
command passed 33 tests. First-admission preparation and append-then-crash
recovery remain covered, while the existing non-transactional side-effect and
receipt-loss boundaries are unchanged.

## Native ACL-safe temporal fallback (Storage Task 2)

Native recall now treats an inferred `createdAt` range as optional policy and
keeps agent/scope ACL, active status, TTL and explicit `validAt` in a separate
mandatory predicate set. All configured private namespaces and authorized
shared-pool candidates participate in one aggregate heuristic decision. Only
when no lifecycle-eligible candidate survives does each private namespace get
one bounded retry without the inferred range; the already bounded shared result
is reused. A partial match prevents fallback, and refined private searches use
the selected heuristic or mandatory policy consistently.

The real-LanceDB regression was first run RED against the reviewed Task 1 base:

```text
PYTHONPATH=plur1bus-hermes/src:plur1bus-controls/src:/Users/cyberblade/.hermes/hermes-agent /Users/cyberblade/.hermes/hermes-agent/venv/bin/python -B -m pytest -q plur1bus-hermes/tests/test_temporal_fallback.py
```

Result before implementation: **1 failed** because `eligible historical
project` remained absent. A second focused RED exposed the shared-only path's
`IndexError` at `recall_tables[0]`; both failures are now covered.

Focused verification:

```text
PYTHONPATH=plur1bus-hermes/src:plur1bus-controls/src:/Users/cyberblade/.hermes/hermes-agent /Users/cyberblade/.hermes/hermes-agent/venv/bin/python -B -m pytest -q plur1bus-hermes/tests/test_temporal_fallback.py plur1bus-hermes/tests/test_valid_time_runtime.py plur1bus-hermes/tests/test_temporal_refinement.py plur1bus-hermes/tests/test_scope_isolation.py plur1bus-hermes/tests/test_runtime_recall_additive_scopes.py plur1bus-hermes/tests/test_shared_pools.py plur1bus-hermes/tests/test_namespaces.py
```

Result: **40 passed in 1.17s**. Native-suite verification with the same
read-only interpreter and `PYTHONPATH`, running `-m pytest -q
plur1bus-hermes/tests`, passed **675 tests and 73 subtests** with 172 known
LanceDB deprecation warnings in 7.80s. No warning was suppressed.

The shared-pool API does not accept a `createdAt` predicate, so recall filters
its bounded authorized result in memory and reuses it on fallback; it does not
perform an unbounded pool scan. This verifies the native source/runtime policy,
not Task 3 parser expansion, Task 5 epistemic invalidation, live Hermes host
behavior, a production migration, or overall recall parity.

The overall native-port coverage is therefore explicitly **incomplete**. The
inventory makes no claim that remaining commits, host-specific contracts,
dashboard behavior, model behavior, or guest acceptance have been reviewed.

## Native temporal parser expansion (Storage Task 3)

`parse_temporal_range()` now remains a range-only, recall-heuristic parser: it
does not create semantic event anchors and never writes `validFrom` or
`validUntil`. It recognizes German and English today/yesterday, bounded days
and hours ago, rolling last week, explicit month-year, contextual past/current
months, prior named weekdays, and standalone years 1970–2999. Quarter and
month-year recognition precede the standalone-year rule. The prior native
`last month` behavior intentionally remains the complete preceding calendar
month; upstream's corresponding parser uses a rolling 30-day range.

Duration wording (`bis heute`, `bis jetzt`, `bis dato`, `until today`, `until
now`, `up to today`, `up to now`, `so far`, `to date`) is case-insensitively
stripped so it cannot turn a deadline-duration into a same-day recall filter;
another independent remaining anchor can still resolve. Explicit same-day
deadlines (`bis heute Abend`, `bis heute 18 Uhr`) still resolve as today. For a
future contextual month, native deliberately returns `None`:
with the fixed 2026-09-11 UTC reference, `im Dezember` does not return the
upstream parser's inverted December-to-September range and does not guess a
previous year. Semantic anchors such as `nach dem X` / `after the X` are
detected before every calendar matcher and return `None`, including when their
event name contains a year, a month-year, or today. They remain a separate,
unimplemented recall contract rather than leaking an anchor object or inferring
a date in this range-only consumer.

The focused RED command was:

```text
PYTHONPATH=plur1bus-hermes/src:plur1bus-controls/src /Users/cyberblade/.hermes/hermes-agent/venv/bin/python -B -m unittest discover -s plur1bus-hermes/tests -p test_temporal_refinement.py -v
```

Result before implementation: 7 tests ran, with **1 failure and 3 errors**:
duration text incorrectly became a range while today/month/weekday cases were
missing. The same focused command passed **7 tests** after implementation.
The parser, temporal-fallback, and valid-time-runtime suites passed **32 tests
and 11 subtests**. Native source verification passed **680 tests, 84 subtests**, with
the existing **172 LanceDB deprecation warnings**; this is source evidence,
not a claim about Hermes host lifecycle, production data, models, publication,
or guest-platform acceptance.

## Native scoped pending-knowledge retirement (Storage Task 4)

The private promotion job now treats `knowledge-promotions.jsonl` as an
append-only event ledger. It selects the latest same-scope event per
`proposalId`, examines at most 100 unique UUID-validated pending memory IDs,
and issues one exact owned-metadata predicate for those IDs and the existing
canonical scope binding. A successful empty exact query certifies a scoped
missing source; an explicitly inactive, epistemically `invalidated`, or
TTL-expired metadata projection certifies `invalidated`. Both append a
`status: stale` event with a reason, rather than deleting the original pending
evidence. A later proposal or confirmation consumes that latest event, so old
pending events cannot resurrect. Confirmed latest events retain the existing
lifetime fingerprint deduplication and 24-hour counting behavior.

An unavailable table, query failure, result overrun/duplicate, or any returned
row outside the issued scope predicate makes the lookup incomplete. In that
case it appends nothing and leaves pending evidence intact; it does not scan a
foreign namespace to interpret the result. The job remains under the existing
writer lock and performs no `KNOWLEDGE.md` write while pruning.

This is intentionally a **metadata-projection** conclusion, not a canonical
memory-state claim. `_metadata_for()` projects `status`, but not
`epistemicStatus`, `expiresAt`, `validFrom`, or `validUntil`, while canonical
runtime cards carry `epistemicStatus`. Thus a canonical card that was
invalidated after an unchanged metadata projection cannot be certified or
retired by this path; it also cannot be represented as a metadata-only success
claim. A future scoped bridge must either query the canonical card source or
atomically project lifecycle/trust/TTL fields into metadata, with an explicit
projection-drift regression. `validAt` remains a query-time semantic-validity
filter and is not inferred as a current lifecycle retirement condition.

The mandated discovery command first ran RED with the missing-source ledger's
last event still `pending`; after the implementation it passed 13 tests.
Additional regressions cover explicit invalidation, inactive/expired metadata,
incomplete and foreign returned lookup rows, idempotent stale retirement, and
confirmation rejection. The controls and scope-consumer command passed 17
tests. These are source-level results only: they do not assert a live Hermes
activation, migration, model, or release state.

## Regression evidence

Capture Task1 independent scoped review: PASS at `4c092b5` after all identified
receipt/retry findings were addressed. Root validation of that exact source:

```text
PYTHONPATH=plur1bus-hermes/src:plur1bus-controls/src:/Users/cyberblade/.hermes/hermes-agent:/Users/cyberblade/.hermes/hermes-agent/venv/lib/python3.11/site-packages /var/folders/gs/kv4mqlgn0y3ftxtypfxm_5xw0000gn/T/tmp.MqkPRIqgFh/venv/bin/python -B -m pytest -q plur1bus-hermes/tests plur1bus-controls/tests distribution/tests hermes-dashboard/tests
```

Result: **867 passed, 73 subtests passed, 172 warnings, 24.90s, exit0**.
The disposable QA venv adds pytest/PyYAML/FastAPI; the production interpreter
packages are read-only on PYTHONPATH. Warnings include known fixture/fallback
messages and LanceDB table_names deprecations; they are not hidden failures or
evidence of guest/model acceptance. No platform/release/production claim follows
from these source tests. Capture identity remains partial lifecycle parity.

`PYTHONPATH=plur1bus-hermes/src:plur1bus-controls/src /Users/cyberblade/.hermes/hermes-agent/venv/bin/python -B -m unittest discover -s plur1bus-hermes/tests -p test_upstream_71244_inventory.py -v`

Result: 5 tests passed. The same suite was first run RED with the expected
missing-audit-JSON error, before the audit document was created.

## Historical snapshot rule

The later foundation gate reads `FEATURES`, `COVERAGE_710`, and
`COVERAGE_712` directly from
`c12ec2bba63d74ac8add8782ab6761472b4149c6:plur1bus-hermes/src/plur1bus_hermes/parity.py`.
It retains every original field in all 57/13/15 rows and permits only the
separate `auditStatus`, `auditEvidence`, and `auditTests` fields. An
evidence-backed audit status is therefore possible without silently rewriting
historical status, detail, or evidence. The inventory still says
`nativePortCoverage: incomplete`.
