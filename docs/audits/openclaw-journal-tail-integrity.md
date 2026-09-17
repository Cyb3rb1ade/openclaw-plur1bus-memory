# OpenClaw Neo journal tail integrity

Base: `70f183af` (7.12.60). OpenClaw already has a backwards 64 KiB journal
reader. The Hermes whole-history-to-tail optimization is not needed here.

## Findings and fix

The reader promises the last **nonempty lines** but stopped based on raw LF
count. A multi-chunk blank suffix therefore returned no records despite older
records being available. Blank runs between records likewise underfilled the
requested window. This can suppress Neo journal/ledger observations; callers
that use the same reader for capping must not silently obtain an incomplete
suffix either.

Count complete nonempty segments backwards, retaining segment state across
chunks. Ignore an incomplete first segment unless BOF was reached. Decode the
assembled bytes once so multibyte UTF-8 records remain intact. Whitespace-only
lines and CRLF retain the existing `split("\n").filter(Boolean)` semantics;
this does not change JSON parsing or turn the limit into a valid-object limit.

Collect chunks with append plus one reversal instead of repeated array-front
insertion. A detected short read now throws before any caller can use a partial
suffix for capping. The descriptor is closed through the existing finally.
Appends beyond the captured file size remain for the next scan.

This is **not** a fixed total-byte cap. Long records or blank runs can require
more chunks (or a full scan when fewer than the requested lines exist), because
silently dropping requested records would violate the contract. Same-size
concurrent rewrites are not detected; no snapshot-isolation claim is made.

## Verification

- Five new regressions; blank-tail selection, interspersed blanks and short-read
  detection failed before the fix. Existing UTF-8 test plus new tests: 6 passed.
- 200 additional seeded suffix comparisons matched full reference reading.
- A >1 MiB dense journal still needs exactly one 64 KiB read for its final 25
  lines. No end-to-end speedup or token saving is inferred from this bound.
- Syntax lint, diff whitespace and npm pack dry-run passed; full-suite and CI
  results are reported in the PR. Tests use disposable files only.
- No dependencies, models, retention settings, compaction schedules, package
  versions, productive installations or Hermes runtime files change.
