# v6.9.10

Maintenance-progress and dedupe hardening release for PLUR1BUS memory.

## Fixed

- Candidate status updates now survive content dedupe and Neo prune, so promote/demote/prune/tombstone commands persist as append-only status records.
- Retrieval-ledger processing no longer advances the watermark when `maxUpdates` truncates a ledger entry; remaining selected IDs resume on the next run.
- Daily decay with the default cap now persists a cursor and rotates through active UUID memories instead of repeatedly processing the first rows.
- LanceDB/Arrow vector wrappers are normalized before update writes to avoid consolidation-time schema failures.

## Verification

- `node --test tests/*.test.js` — 221 passing, 0 failing.
