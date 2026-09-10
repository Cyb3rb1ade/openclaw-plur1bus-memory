# Hermes 7.12.44 pinned delta inventory

This is an inventory gate, not a native-port completion review. Its upstream
range is `v7.12.7..a3f48f28ac647e81c5260e8a1dbab7977bf9fb51`; its immutable
Hermes preservation baseline is
`c12ec2bba63d74ac8add8782ab6761472b4149c6` (`7.12.7-hermes.4`). The machine
readable source of truth is `hermes-7.12.44-delta.json`.

## Inventory result

- 37 non-merge upstream commits and all 90 changed upstream paths are captured
  from Git, rather than from release headings.
- Every commit is deliberately `unreviewed`. A populated commit inventory is
  neither evidence of a reachable Python implementation nor a status upgrade.
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

The overall native-port coverage is therefore explicitly **incomplete**. The
inventory makes no claim that remaining commits, host-specific contracts,
dashboard behavior, model behavior, or guest acceptance have been reviewed.

## Regression evidence

`PYTHONPATH=plur1bus-hermes/src:plur1bus-controls/src /Users/cyberblade/.hermes/hermes-agent/venv/bin/python -B -m unittest discover -s plur1bus-hermes/tests -p test_upstream_71244_inventory.py -v`

Result: 5 tests passed. The same suite was first run RED with the expected
missing-audit-JSON error, before the audit document was created.
