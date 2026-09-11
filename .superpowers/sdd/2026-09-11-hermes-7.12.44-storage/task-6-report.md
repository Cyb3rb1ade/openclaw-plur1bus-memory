# Storage Task 6 report — canonical knowledge-source revalidation

## Scope and implementation

- Added `_knowledge_sources_by_ids(selector, memory_ids)` with at most 100
  unique safe UUIDs, one current-writer `memories` query, exact scope predicate
  before the limit, returned-ID/owner validation, and route identity validation
  both before and after the query.
- Domain construction captures the verified effective-generation writer
  identity under the native writer lock. A later generation switch makes that
  captured Domain incomplete for knowledge certification; a fresh Domain binds
  the newly active target. Missing/unreadable writer routes never create a
  table or certify absence.
- Proposal generation shares one bounded canonical lookup between existing
  pending retirement and new candidates. Unexamined IDs remain pending and
  cannot emit a new proposal. Missing or lifecycle-invalid canonical sources
  append latest `stale` events only after complete metadata and source evidence.
- Canonical `status`, hard-TTL `expiresAt`, and
  `is_recallable_epistemic()` gate both proposals and confirmations. Canonical
  content/type supplies the text and fingerprint; metadata remains the source
  of human importance and cognition gates. `validUntil` is not treated as TTL.
- Confirmation rechecks exactly one current canonical source under the existing
  writer lock before the existing managed `KNOWLEDGE.md` writer. A later
  explicit confirmation for the same UUID uses its newest confirmed text;
  append-only confirmation history and manual file content remain preserved.
- `_metadata_for()` copies present canonical `status`, `epistemicStatus`,
  `expiresAt`, `validFrom`, and `validUntil` verbatim. It does not invent an
  epistemic state for a legacy row where that field is absent.

## RED evidence

Required command, using the installed Hermes interpreter read-only with `-B`:

```text
PYTHONPATH=plur1bus-hermes/src:plur1bus-controls/src /Users/cyberblade/.hermes/hermes-agent/venv/bin/python -B -m pytest -q plur1bus-hermes/tests/test_knowledge_promotions.py plur1bus-hermes/tests/test_knowledge_canonical_sources.py
```

Before production changes: **12 failed, 18 passed, 4 subtests passed, 108
warnings**, exit 1. The reachable failures included canonical invalidation
still confirming, metadata text remaining authoritative after canonical drift,
generation-switched stale Domain confirmation, missing
`_knowledge_sources_by_ids`, and absent lifecycle projection fields. This was
the intended behavioral RED, not an import/environment failure.

RED checkpoint: `d83f211` (`test(hermes): reproduce stale canonical knowledge sources`).

A narrow adjacent RED then reproduced same-UUID reconfirmation: the second
proposal and confirmation succeeded in the ledger but the managed file retained
the first text because the old confirmed event reached first-wins dedup first.

```text
PYTHONPATH=plur1bus-hermes/src:plur1bus-controls/src /Users/cyberblade/.hermes/hermes-agent/venv/bin/python -B -m pytest -q plur1bus-hermes/tests/test_knowledge_canonical_sources.py -k new_explicit_confirmation_replaces_same_id_managed_text
```

Result before the last-wins explicit-confirmation assembly: **1 failed, 10
deselected, 18 warnings**, exit 1.

## GREEN and verification

Final focused command (same required command as above): **26 passed, 11
subtests passed, 272 warnings in 0.97 s**, exit 0.

Controls and scope consumers, run once after the implementation settled:

```text
PYTHONPATH=plur1bus-hermes/src:plur1bus-controls/src /Users/cyberblade/.hermes/hermes-agent/venv/bin/python -B -m pytest -q plur1bus-hermes/tests/test_controls.py plur1bus-hermes/tests/test_scope_consumers.py
```

Result: **17 passed, 14 warnings in 0.57 s**, exit 0.

Complete native Hermes pytest suite, run once after the implementation settled:

```text
PYTHONPATH=plur1bus-hermes/src:plur1bus-controls/src /Users/cyberblade/.hermes/hermes-agent/venv/bin/python -B -m pytest -q plur1bus-hermes/tests
```

Result: **711 passed, 109 subtests passed, 422 warnings in 7.44 s**, exit 0.
Warnings are the existing LanceDB `table_names()` deprecations and documented
fixture/fallback warnings; none was suppressed.

Implementation checkpoint: `cdfad23` (`fix(hermes): revalidate canonical knowledge sources`).

## Files changed

- `plur1bus-hermes/src/plur1bus_hermes/domain.py`
- `plur1bus-hermes/tests/test_knowledge_promotions.py`
- `plur1bus-hermes/tests/test_knowledge_canonical_sources.py`
- `docs/audits/hermes-7.12.44-delta-review.md`
- `.superpowers/sdd/2026-09-11-hermes-7.12.44-storage/task-6-report.md`

## Self-review and proof boundaries

- `git diff --check` passed before the implementation commit and again for the
  audit/report changes. Canonical SQL literals originate only from UUID
  validation; scope is applied pre-limit and independently checked on returned
  rows. No all-namespace recovery search exists.
- The proposal path issues one canonical lookup of at most 100 IDs; confirmation
  issues one exact-ID lookup. Incomplete evidence leaves pending history intact
  and prevents `KNOWLEDGE.md` mutation.
- Real temporary LanceDB fixtures cover invalidation, deletion, archive, expiry,
  content/type drift, missing table, query failure, foreign/duplicate collision,
  generation switch, legacy missing epistemic column, past `validUntil`, and a
  valid canonical+metadata confirmation.
- Tests assign no `HOME` override and write only to explicit temporary data
  directories. The installed Python environment was read-only and bytecode was
  disabled with `-B`.
- No production profile, live database, human file, runtime activation,
  migration, model download, package, signing, registry, release, or publication
  was touched. These results are source-level native evidence only.
- Independent Task-6 review is still required before the broader storage plan
  or candidate can be called complete. Canonical evolving episodes/cognition,
  Neo candidate indexing, and historical feature coverage remain later work.
