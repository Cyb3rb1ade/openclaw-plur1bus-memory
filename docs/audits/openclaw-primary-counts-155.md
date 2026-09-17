# OpenClaw primary-agent count integrity (#155)

Base: `70f183af` (7.12.60). This PR is OpenClaw-only; it contains no Hermes
payload, version bump, installation or publication.

## Contract

`cards.byPrimaryAgent[].cards` now permits `null` to mean **unknown**, in addition
to a nonnegative safe integer. Both redacting projections retain that sentinel,
and the shipped HTML displays **Unavailable** while retaining the agent ID.
Older snapshots without the primary-agent group still project an empty list.
Other count groups retain their existing numeric-only contract.

A primary-agent count is complete only if every private namespace was listed
and every occurrence of that agent was successfully counted within the scan
budget. A successful subtotal cannot mask a failed/capped namespace. Absence
from every successfully enumerated namespace is still a legitimate zero.
Unrelated shared-pool failures do not invalidate complete private counts.
Missing roster behavior, read-only inspection and secret redaction are retained.

The existing byAgent/namespace subtotals and global degraded status are not
redefined by this focused fix. Consumers of the new primary-agent group must
not coerce `null` to zero.

## Verification (2026-09-17)

- Nine new regressions: seven demonstrated the bug before the fix; two guard
  existing complete-count/validation behavior.
- 46 focused scanner/projection/HTML tests passed, including end-to-end unknown
  count rendering and count/list errors, cap exhaustion and mixed namespaces.
- Node 22 full suite with c8: 4,750 tests, 4,674 passed, 76 skipped, zero failures.
  Overall statement/line coverage 86.13%; changed modules 93.33–95.82%.
- Syntax lint, diff whitespace check and npm pack dry-run passed. No build or
  TypeScript project is configured; this package ships its JavaScript source.
- Clean lock-based install used `npm ci --ignore-scripts`, so no real profile
  or cron installer ran. Required-dependency audit: zero findings. Optional
  inference chain: existing four affected entries tracked separately in #150;
  no dependency versions are changed here.
- The host's Node 26 failed to start c8 through yargs; verification used the
  supported Node 22 runtime. This is not represented as a passing Node 26 gate.
