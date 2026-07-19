# Fix Report — BUG-01 Registered Forget/Correct Initiation

Date: 2026-07-19
Scan bundle: `6dff096efe936f7ec3d0e11a8ba83bf08671ad4e_20260718T170344Z`
Outcome: **fixed**

## Finding and broken path

The reliability audit reported BUG-01 as high severity: registered `/forget` and `/correct` initiation always failed with `summarizer is not defined`.

The concrete path was:

```text
plugin.register(api)
  -> registered forget/correct handler (or /plur1bus alias)
  -> authorized initiation
  -> normalizeCommandInput(..., summarizer, ...)
  -> ReferenceError before resolveCandidates/createConfirmation
  -> localized failed response
```

`runMemoryCommand` worked because it declared an agent-scoped summarizer locally. The two destructive handlers referenced that name outside its lexical scope.

## Fix and invariant

Each affected handler now creates:

```js
const summarizer = makeQuerySummarizer(mergingLlmCfg, api.logger, agentId);
```

immediately after resolving its invocation-specific `agentId`. This is the narrowest repository-native fix: two production lines, no public interface change, and no movement of length validation, authorization, confirmation, candidate selection, archive, correction, registration, or alias logic.

Invariant restored: every registered memory-query normalization path receives an agent-scoped `Function|null` summarizer before initiation normalizes input.

## Proof

### RED

Before changing `index.js`, the real-plugin regression produced:

```text
tests 3; pass 1; fail 2
/memory passed
/forget: ❌ /forget failed: summarizer is not defined
/correct: ❌ /correct failed: summarizer is not defined
```

The fixture used real plugin registration, the real `memory_store` factory, real temporary LanceDB state, and patched only the optional local embedding-model boundary.

### GREEN and original trigger

- `node --test tests/command-reachability.test.js` — exit 0.
- `node tests/command-reachability.test.js` — 3/3 tests passed.
- `node --test --test-name-pattern='registered /forget|registered /correct' tests/command-reachability.test.js` — exit 0; both formerly broken initiations reached confirmation without the ReferenceError.
- Owning command/input suite — 5/5 files passed, including real registered correct owner-confirm, archive verification, corrected recall, and the existing helper control.

### Bypass and preservation review

- Top-level commands and `/plur1bus*` aliases converge on the same fixed handlers.
- Both callsites pass the invocation's `agentId`; the deterministic cache guard now recognizes all five exact scoped callsites and passes.
- Confirm branches do not invoke query normalization or the summarizer.
- Unauthorized forget remains denied before candidate lookup.
- Wrong-user tokens remain rejected with `security.wrong_user`.
- Oversized input remains rejected before normalization (`p1-robustness` plus Telegram smoke: 2/2 files passed).
- `/memory` positive control still recalls a seeded memory.
- Forget still archives before deletion. Correct is now proven through a fresh real registered handler from initiation through owner-confirm, archive creation, and corrected recall; helper coverage remains an additional control.

## Repository gates

- `npm run lint` — exit 0 after final changes.
- First serial run identified only a stale deterministic callsite-count guard (`5 !== 3`); this was retained as RED evidence and minimally updated to 5.
- `node --test tests/llm-result-cache-integration.test.js` — exit 0 after that guard update.
- Sandboxed `node --test --test-concurrency=1 tests/*.test.js test/*.test.js` diagnostic — 259 files passed; only the known nested-spawn `setup-feature-crons-symlink.test.js` file-level harness artifact failed.
- Required direct control `node --test tests/setup-feature-crons-symlink.test.js` — 1/1 passed, exit 0.
- Authoritative outside-sandbox `node --test --test-concurrency=1 tests/*.test.js test/*.test.js` — 2,556 tests; 2,555 passed; 0 failed; 1 skipped; exit 0.

## Changed files

- `index.js`
- `tests/command-reachability.test.js`
- `tests/llm-result-cache-integration.test.js`
- `docs/superpowers/plans/2026-07-19-b1-command-reachability.md`
- `docs/audits/2026-07-19-bug-01-command-reachability-fix.md`

## Test-harness adjustments and remaining uncertainty

During GREEN, the planned forget assertion was corrected to tolerate the expected query echo in the semantic not-found response. Review then required the real correct owner-confirm proof. Adding those assertions to the original single-generation fixture produced the focused RED: 2/3 tests passed, Lance reported `Column 'remindAt' is declared as non-nullable but contains null values`, and the handler returned an internal update error.

Tracing showed that the first raw `MemoryDB` had cached the create-table schema before the adapter added reminder columns. The final test uses a product-realistic migrated lifecycle without a production hook: one real API generation seeds the row and runs registered `/memory` to migrate the table, shuts down its adapter and pool, then a fresh API/pool generation on the same path performs correct initiation, wrong-user rejection, owner-confirm, archive verification, and corrected recall. The fresh `MemoryDB.init()` observes the complete schema and preserves all non-null defaults. The focused test then passed 3/3.

The separate same-generation raw-schema-cache problem remains unresolved and requires its own scope; B1 changes no DB production code and does not claim to fix it.

The sandbox-only nested-spawn symlink artifact remains environment-specific and unrelated to B1; its direct test and the authoritative outside-sandbox serial suite both pass.

## Integrity

- Fix base: `1735d8e625d9582e39ef9d04c43052d442bba703`.
- Main checkout remained unchanged at `6dff096efe936f7ec3d0e11a8ba83bf08671ad4e`.
- No B2 work was included.
