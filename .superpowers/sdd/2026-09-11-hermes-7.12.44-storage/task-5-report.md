# Task 5 report — epistemically invalidated recall exclusion

## Scope and implementation

- Added `is_recallable_epistemic(row)` in `epistemic.py`: absent, `None`, and
  blank legacy values remain eligible; case- and whitespace-normalized
  `invalidated` is rejected.
- Private recall reads each opened table schema without modifying it. Tables
  containing `epistemicStatus` receive a LanceDB pre-limit predicate preserving
  ACL scope, active status, expiry, and optional `validAt`; legacy schemas omit
  only the epistemic predicate. A race naming only `epistemicStatus` retries
  once without that clause. Multi-column and unrelated errors propagate.
- Shared-pool reads apply the equivalent schema-aware pre-limit predicate and
  same narrow race handling, without migrations on read-only pool tables.
- The normalized pure gate applies to aggregate primary/refined/shared rows and
  again after additive boosters.
- Extended Task 2 temporal symmetry: an in-range observed shared result blocks
  the old private fallback; an invalidated shared result does not.

## RED evidence

Command:

```sh
PYTHONPATH=plur1bus-hermes/src:plur1bus-controls/src /Users/cyberblade/.hermes/hermes-agent/venv/bin/python -B -m unittest discover -s plur1bus-hermes/tests -p test_epistemic_recall.py -v
```

Before the runtime change, the real LanceDB fixture failed as required:

```text
FAIL: test_real_lancedb_invalidated_rows_cannot_starve_an_observed_hit
AssertionError: 'observed eligible memory' not found in '- invalidated nearest memory 0'
Ran 1 test in 0.756s
FAILED (failures=1)
```

The fixture writes 20 nearer invalidated rows and a lower-ranked observed row,
so this is runtime retrieval evidence rather than an import-only failure.

## GREEN evidence

Focused command, against the installed Hermes venv with `-B` and temporary
`HOME`:

```sh
HOME="$(mktemp -d)" PYTHONPATH=plur1bus-hermes/src:plur1bus-controls/src /Users/cyberblade/.hermes/hermes-agent/venv/bin/python -B -m unittest discover -s plur1bus-hermes/tests -p test_epistemic_recall.py -v
```

Output: `Ran 8 tests in 1.192s` — `OK`.

Native recall suite, also with temporary `HOME`, installed venv, and `-B`:

```sh
task5_home=$(mktemp -d)
for test5_file in test_runtime_recall_additive_scopes.py test_temporal_fallback.py test_valid_time_runtime.py test_shared_pools.py; do
  HOME="$task5_home" PYTHONPATH=plur1bus-hermes/src:plur1bus-controls/src /Users/cyberblade/.hermes/hermes-agent/venv/bin/python -B -m unittest discover -s plur1bus-hermes/tests -p "$test5_file" -v || exit $?
done
```

Output: `2 + 11 + 15 + 4 = 32 tests`, all `OK`. The expected
`additive recall booster failed ... RuntimeError` warning is asserted fail-open
behavior in the existing valid-time test; its test passed.

## Files changed

- `plur1bus-hermes/src/plur1bus_hermes/epistemic.py`
- `plur1bus-hermes/src/plur1bus_hermes/runtime.py`
- `plur1bus-hermes/src/plur1bus_hermes/shared_pools.py`
- `plur1bus-hermes/tests/test_epistemic_recall.py`
- `plur1bus-hermes/tests/test_shared_pools.py`
- `plur1bus-hermes/tests/test_temporal_fallback.py`

## Delta review and limitations

- `git diff --check` passed. Review confirmed no read-path migration, no broad
  missing-column fallback, and no weakening of ACL/status/TTL/validAt clauses.
- The audit evidence in the task brief remains the upstream reference: its
  pinned adapter filters invalidated rows both before its limit and after
  retrieval. This port now has corresponding native pre-limit and final gates.
- This task does not activate installed profiles, download models, run a live
  migration, or publish anything. Installed Python was used only read-only for
  tests with `-B` and temporary homes.

## Review round 1 corrective evidence

The initial narrow `epistemicStatus` schema-race fallback issued its first
no-epistemic query directly. A later missing `validFrom`/`validUntil` or
`expiresAt` error therefore bypassed the existing lifecycle retry ladder.

RED command:

```sh
task5_round1_home=$(mktemp -d)
HOME="$task5_round1_home" PYTHONPATH=plur1bus-hermes/src:plur1bus-controls/src /Users/cyberblade/.hermes/hermes-agent/venv/bin/python -B -m unittest discover -s plur1bus-hermes/tests -p test_epistemic_recall.py -v
```

Output before the corrective runtime change: `Ran 9 tests in 0.735s` — four
errors for the sequential `epistemicStatus -> validFrom`, `validFrom ->
epistemicStatus`, `epistemicStatus -> expiresAt`, and `expiresAt ->
epistemicStatus` races. The matching Shared Pool RED command produced the same
four errors (`Ran 5 tests in 0.538s`).

GREEN used those same commands with `task5_round1_home` as a task-specific
temporary path: runtime output `Ran 9 tests in 0.514s` — `OK`; Shared Pool
output `Ran 5 tests in 0.530s` — `OK`.

The real-LanceDB primary fixture now creates a nullable `epistemicStatus`
schema and a separate no-column legacy schema. With twenty nearer invalidated
vectors it verifies observed, `None`, blank, and absent-column rows remain
eligible while no invalidated content is returned.
