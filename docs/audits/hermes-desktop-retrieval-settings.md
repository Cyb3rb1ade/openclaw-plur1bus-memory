# Hermes Desktop retrieval settings — local acceptance, 2026-09-06

## Implemented

- Native embedding/reranker provider, model, endpoint and environment-key-reference forms.
- Dimension migration through reviewed source snapshot → separate staged vectors → full
  non-vector identity validation → separately approved generation activation.
- Repeated generation changes use the certified active source, not the abandoned
  original DB. Regression includes a post-first-migration capture, interrupted second
  activation, restoration of the prior pointer, recovery and stale-plan rejection.
- Reranker changes preserve unrelated profile configuration and effective embeddings,
  test the selected backend with synthetic text, back up config, and save atomically.
- Every mutation is native-authenticated, one-use reviewed, scope/config-bound and
  blocked by a live runtime-generation lease. No process is stopped by these actions.
- Asynchronous jobs expose bounded status/progress, recover the latest in-process job
  after navigation/lost responses, and never auto-retry failed mutations.
- Explicit local-transformers revision/offline settings now reach model construction
  and distinguish in-process model cache entries.

## Verification

- Python: 513 passed, 55 subtests; existing LanceDB deprecation warnings only.
- Native distributed ESM harness passed; installer preservation suite passed;
  npm lint and git diff whitespace checks passed.
- Real temporary LanceDB tests: source backup, original-vector preservation, metadata
  equality, repeated activation/recovery, runtime lease refusal and config backup.
- Local wheel built without dependency changes and installed into the Hermes venv.
  Changed Python modules match source by bytes. Flat plugin copies updated for the
  four already-enabled PLUR1BUS profiles. Desktop UI copies match across all six homes.
- Computer Use after a full Desktop restart: Bernhardine's 13,105 records correctly
  previewed a 768 → 512 migration. The start button was disabled without confirmation.
  Switching to Bernd discarded that preview and showed agent `main`, 9,086 records,
  still 768 dimensions. Reranking provider menu and a disabled-target review were
  verified; save remained disabled without confirmation.

## Explicit boundaries

No productive provider save, migration, embedding API call or model download was
approved in UI QA. Productive data/configuration and the separate Telegram gateway
were not changed or restarted. Return to the original profile discards QA drafts.
This is a local source/build/install acceptance, not a newly published release.

The operator must stop cooperating Memory runtimes before execution and restart
them after activation/save. Existing lease protection is not bypassed for UI ease.
Model preparation remains in the operator CLI; selecting a model does not establish
availability. Empty/custom-namespace stores outside the current staged migration
contract fail closed. Job receipts are process-local; deterministic staging and
generation recovery journals persist. After a backend restart, an unchanged-source
stage can be re-reviewed/resumed; interrupted activation recovery uses the operator
CLI. Old generations/backups are retained, never automatically deleted.
