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

The overall native-port coverage is therefore explicitly **incomplete**. The
inventory makes no claim that remaining commits, host-specific contracts,
dashboard behavior, model behavior, or guest acceptance have been reviewed.

## Regression evidence

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
