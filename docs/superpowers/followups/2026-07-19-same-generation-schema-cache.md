# Follow-up: Same-generation LanceDB schema-cache stale-field failure

**Date:** 2026-07-19
**Discovered during:** B1 (BUG-01) regression-fixture work; see `docs/audits/2026-07-19-bug-01-command-reachability-fix.md`, sections "Fixture lifecycle" and "Remaining uncertainty".
**Status:** Open — reproducible, not an audited finding, deliberately not fixed in B1.

## Problem

When a brand-new table is created, adapter-migrated, and then semantically updated through the *same already-open* raw `MemoryDB` instance, `safeUpdate` fails: the first raw `MemoryDB` caches the base schema's fields, the DB adapter then adds non-null reminder columns, and the stale field cache filters the reminder defaults out of subsequent writes. Lance panics with:

```text
Column 'remindAt' is declared as non-nullable but contains null values
```

and the user-facing handler returns `❌ /correct failed: Update not possible: internal error; details were logged`.

A fresh `MemoryDB.init()` on the same path (new generation/pool) reads the complete schema and writes all non-null defaults correctly — which is why normal persisted-runtime lifecycles do not hit this, and why the B1 regression uses a two-generation fixture.

## Scope ruling

Not an audited finding, so per the design spec's opportunistic-low rule it may only be fixed inside **B7** (LanceDB Lifecycle and Atomic Updates) if the same function/control path is already being changed there and one fixture proves both closures. Otherwise it stays a separately scoped investigation after the remediation completes. It must not be conflated with BUG-01, and no other batch should silently absorb it.

## Repro sketch

1. Register the plugin with a fresh `baseDbPath`; store a row (raw `MemoryDB` created with base schema, fields cached).
2. Run a registered `/memory` recall so the DB adapter migrates the table (adds non-null reminder columns).
3. Without restarting the pool/plugin, drive `/correct` through owner confirmation on that row → Lance panic above.

The two-generation variant (shutdown after step 2, fresh register before step 3) passes and is what `tests/command-reachability.test.js` encodes.
