# Whole-storage final fix report

Base: `12c7449` (pinned upstream 7.12.47 integration already present).

Commits:

- `d26e721` — `test: reproduce final storage review findings`
- `d9cf8f4` — `fix: close final storage replay gaps`

## Result

All three Important findings in `final-fix-brief.md` are fixed.

1. `on_turn` resolves relative cognition against immutable UTC `capturedAt` and
   stores compact admission-time cognition and speaker-alias decisions in new
   journal plans. Replay reconstructs source-derived segment text from the
   hash-bound input while retaining the original alias identity. Legacy plans
   without this metadata are never re-fingerprinted or admitted anew; drift
   still fails closed.
2. The entire journal descriptor set is preflighted before initial receipt
   publication, receipt state advancement, or journal append. Plans require an
   exact legacy/new shape, deterministic row ID and fingerprint, true JSON
   integers rather than booleans, bounded and exact serialized lengths,
   contiguous ranges, and valid existing target ownership. Episode preflight,
   no-follow probing, size caps, exact materialized prefixes, and the sticky
   receipt-required callback remain intact.
3. A shared epistemic predicate builder now gives private, refined, and shared
   LanceDB searches the same Unicode-whitespace strip plus lowercase behavior
   as the Python final gate. Null, blank, and absent-column legacy cases remain
   eligible. ACL/status/TTL/valid-time filters and the narrow missing-only-
   `epistemicStatus` retry ladder were not loosened.

## RED evidence

Command:

```text
PYTHONPATH=plur1bus-hermes/src:plur1bus-controls/src:/Users/cyberblade/.hermes/hermes-agent:/Users/cyberblade/.hermes/hermes-agent/venv/lib/python3.11/site-packages /var/folders/gs/kv4mqlgn0y3ftxtypfxm_5xw0000gn/T/tmp.MqkPRIqgFh/venv/bin/python -B -m pytest -q plur1bus-hermes/tests/test_turn_identity.py plur1bus-hermes/tests/test_epistemic_recall.py plur1bus-hermes/tests/test_shared_pools.py
```

Before the source fix: exit 1, `5 failed, 27 passed, 14 subtests passed`.
Failures reproduced partial journal mutation from a later boolean length,
speaker-map replay conflict, private Unicode-whitespace starvation, missing
refined shared predicate text, and shared-pool starvation.

## GREEN evidence

Focused command:

```text
PYTHONPATH=plur1bus-hermes/src:plur1bus-controls/src:/Users/cyberblade/.hermes/hermes-agent:/Users/cyberblade/.hermes/hermes-agent/venv/lib/python3.11/site-packages /var/folders/gs/kv4mqlgn0y3ftxtypfxm_5xw0000gn/T/tmp.MqkPRIqgFh/venv/bin/python -B -m pytest -q plur1bus-hermes/tests/test_cognition.py plur1bus-hermes/tests/test_emotion_tiers.py plur1bus-hermes/tests/test_turn_identity.py plur1bus-hermes/tests/test_capture_retry.py plur1bus-hermes/tests/test_capture_retry_scopes.py plur1bus-hermes/tests/test_domain.py plur1bus-hermes/tests/test_epistemic_recall.py plur1bus-hermes/tests/test_shared_pools.py plur1bus-hermes/tests/test_temporal_refinement.py plur1bus-hermes/tests/test_temporal_fallback.py plur1bus-hermes/tests/test_valid_time_runtime.py plur1bus-hermes/tests/test_runtime_recall_additive_scopes.py
```

Result: exit 0, `97 passed, 31 subtests passed`, with 44 existing LanceDB
`table_names()` deprecation warnings.

Full source QA command:

```text
PYTHONPATH=plur1bus-hermes/src:plur1bus-controls/src:/Users/cyberblade/.hermes/hermes-agent:/Users/cyberblade/.hermes/hermes-agent/venv/lib/python3.11/site-packages /var/folders/gs/kv4mqlgn0y3ftxtypfxm_5xw0000gn/T/tmp.MqkPRIqgFh/venv/bin/python -B -m pytest -q plur1bus-hermes/tests plur1bus-controls/tests distribution/tests hermes-dashboard/tests
```

Result: exit 0, `924 passed, 124 subtests passed, 534 warnings` in 26.87s.
Warnings were the existing LanceDB `table_names()` deprecations and were not
suppressed.

`git diff --check` also passed.

## Self-review and remaining concerns

- Source text, role, session, agent, scope, capture ID, timestamp, descriptor
  ownership, and complete-record fingerprints remain fail-closed. The receipt
  fingerprint was not weakened.
- The new speaker snapshot stores only encountered normalized alias decisions;
  it does not duplicate segment/source bodies. Source hashes bind the replayed
  body used to reconstruct those segments.
- Real LanceDB exercised the centralized `regexp_replace(..., '^\\s+|\\s+$',
  '', 'g')` predicate for tabs, newlines, NBSP, and em-space. Mocked refined
  searches verify the same builder remains on both search passes.
- Legacy prepared receipts lacking admission metadata can still become
  unreplayable after speaker configuration drift. That is the intentional
  fail-closed boundary; they are not rewritten with current metadata.
- Exactly-once remains limited to receipt-indexed turn journal rows and the
  per-capture episode. Mood, reminder, embedding, and other independent side
  effects remain outside that transaction.
- No production configuration/database, installed profile, model, native
  unrelated feature, signing, publication, or guest-runtime state was changed.
