# Hermes 7.4.8 contract matrix

This matrix compares the immutable upstream PLUR1BUS `v7.4.8` commit
`14ef790e9a0d9c164aa12cab8f5b7ec83b353b30` with the Hermes adapter. A Python
port is added only when Hermes can reach the corresponding behavior. Every
OpenClaw-only change remains present in the merged JavaScript package.

| Release | Upstream commits | Contract | Hermes path | Disposition |
| --- | --- | --- | --- | --- |
| 7.4.2 | `ae29436`, `cd41e7a` | Skill-miner report directory handling | No native skill-miner or Telegram skill-command path | OpenClaw-only; shipped in JS |
| 7.4.3 | `cadde2b`, `2afa444` | Reminder false-positive and extraction fixes | Hermes consumes due-reminder state but has no reminder extractor | OpenClaw-only; shipped in JS |
| 7.4.4 | `d8c7af4`, `f823907` | Reminder text, topic, and source persistence | No native Hermes reminder writer | OpenClaw-only; shipped in JS |
| 7.4.5 | `0236fe4`, `17d689b` | LanceDB `confirmed` boolean-literal compatibility | Python uses native `is_confirmed` values, not the JavaScript SQL predicate | OpenClaw-only; shipped in JS |
| 7.4.6 | `8c28d1c`, `a9d7970` | Credential signals require concrete secret content | Native capture calls `classify_critical` | Ported in Python with negative and positive regressions |
| 7.4.7 | `4e72a47`, `e47a7ea` | Partial-failure accounting for classify-recent | Hermes classifies inline and has no classify-recent cron batch | OpenClaw-only; shipped in JS |
| 7.4.8 | `b5533be`, `14ef790` | Second JavaScript `confirmed` predicate fix | No equivalent Python query builder | OpenClaw-only; shipped in JS |

## Hermes host compatibility audit

The official `NousResearch/hermes-agent` main branch was audited through
`1bbb6e5bce56e721ab685af4cd87df21bbff4d35`. The relevant change is
pre-compression checkpoint API v2: the host supplies normalized direct
user/assistant evidence, excludes system/tool/tool-only/prior compressed
summaries, and can require a compatible successful checkpoint before lossy
context rewriting.

`Plur1busMemoryProvider` now advertises
`pre_compress_checkpoint_api_version = 2`. Its hook also normalizes an older
host's raw transcript, writes a content-addressed checkpoint below
`state/pre-compress-checkpoints/`, fsyncs file and directory around an atomic
replacement, and only then flushes queued captures. Identical evidence is
idempotent but still revalidates and fsyncs the visible file plus its parent
before acknowledging success. Checkpoint directories are forced to `0700` and
files are created as `0600` before evidence is written. Write, sync, permission,
or identity failures propagate to preserve the host's fail-closed guarantee.

The locally installed Hermes checkout audited for this release is
`76e306c45843607e6dc135d23c13d3654417ebd5` (`0.20.5`). It does not yet enforce
checkpoint API v2, but it calls the same provider hook and ignores the added
capability attribute, so the adapter remains backward compatible. This release
does not update the Hermes host itself.

## Regression evidence

- Secret-word negatives: password/API-key/token planning, absence/state
  descriptions, masks, and configuration placeholders do not become critical.
- Concrete-secret positives: assigned password, API key, and access code remain
  critical and content-suppressed.
- Checkpoint v2: direct evidence only, content-addressed idempotence, byte-stable
  replay, private modes during creation, concurrent fast-path durability,
  post-replace fsync retry, and propagated filesystem failure.
- Package inspection requires this matrix and version-aligned npm and Python
  metadata in the Hermes artifact.
