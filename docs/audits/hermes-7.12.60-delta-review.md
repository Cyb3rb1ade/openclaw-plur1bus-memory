# Hermes 7.12.60 delta review

Candidate: `7.12.60-hermes.0` (Python `7.12.60`). Previous published Hermes:
`7.12.56-hermes.0`, commit `75f272fbf0127dea1ccea1cfaee7fdd9142466f4`.
Upstream baseline: `5d79fb91a907b13929e41523348b761a748e6c81`.
Upstream target: `bcb80ccef6ce5ab9e4604cfe923901885cc59d9e` (`v7.12.60`).
All seven intervening commits are merged, not selectively cherry-picked.
Only an upstream trailing blank line in `tests/db-adapter-timeouts.test.js`
is trimmed for the whitespace gate; its test contents remain identical.

## Complete inventory (22 paths) and native disposition

| Upstream paths | Hermes adaptation |
| --- | --- |
| `lib/afterthought.js`, `tests/afterthought.test.js` | Native `proactive.py` selects the newest eligible open/corrected thread, using its own timestamp, at 30–180 minutes. Latest closed state dominates; governor/cooldown retained. Explicit Correction/Korrektur captures enter open-thread extraction. Legacy timestamp-less threads require a unique matching episode. No new LLM call. |
| `index.js`, `tests/llm-router.test.js` | Native internal backend honors `llmRouter.defaultModel` only when explicit `llm.model` is absent/blank. Existing transport, credentials, explicit model and cache remain; chat routing untouched. OpenClaw host routing is not imitated. |
| `lib/db-adapter.js`, `tests/db-adapter-timeouts.test.js` | Native operator retries only recognized commit conflicts: at most 12 attempts, 3–60s exponential backoff, 600s retry budget. Exact generation revalidated each attempt; authorization and operation guard retained. The budget cannot cancel a synchronous LanceDB call. Resilience parity, not a claimed speedup. |
| `lib/dreaming/rem-dream.js` | Native deterministic REM returns incomplete when an expected narrative is missing, before journal/diary/echo/cursor writes; rate gate remains retryable. Explicit narrative disable is allowed. Native REM is not OpenClaw's narrative LLM pipeline. |
| `lib/memory-request-context.js`, `tests/b13-memory-request-context.test.js` | JS channel-binding roster retained. Native authority remains the active Hermes profile, not sibling profile enumeration or arbitrary subagents. |
| `lib/control-plane-health.js`, `tests/control-plane-health.test.js` | Native status adds `cards.byPrimaryAgent` from the already-read active-profile private count. Unknown remains null, measured zero stays zero. No additional DB scan. Shared scopes are not private agent counts. |
| `lib/control-plane-projection.js`, `tests/control-plane-projection.test.js` | JS projection retained; native projection exposes safe active-profile/agent identifiers and the same scoped count. |
| `lib/setup/control-ui-plugin-runtime.js`, `tests/control-ui-plugin-runtime.test.js` | Primary-agent card section in both Hermes Desktop and web UI, explicitly active-profile-only. Existing profile/connection binding, Workshop, provider settings, dimension migration and Obsidian remain. No claim of all-profile aggregation. |
| `lib/setup/feature-cron-plan.js`, `tests/feature-cron-plan.test.js` | JS channel-less main/default fallback retained. Native jobs already select an explicit profile without requiring channel bindings; no duplicate scheduler installed. |
| `tests/release-731-runtime-callsite-security.test.js` | Upstream security expectations retained alongside native ACL/confirmation tests. |
| `package.json`, `package-lock.json`, `openclaw.plugin.json` | Candidate versions aligned; dependency graph and Hermes publish tag retained. Python packages/manifests use 7.12.60. |
| `CHANGELOG.md` | All .57–.60 notes and prior Hermes history retained, with native notes added. |

## Upstream findings

- [Issue #155](https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory/issues/155): reproduced false zero primary-agent card count after partition inspection fails. Native adaptation avoids this; bundled upstream JS remains unchanged pending upstream resolution.
- [Issue #150](https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory/issues/150): optional JS inference audit findings persist. Four affected entries represent two underlying advisories, not four demonstrated reachable exploits. Python Hermes does not load this JS chain. No blind force-upgrade and no claim of a clean full npm audit.

## Preserved surfaces and boundaries

The previous native provider, Controls, capture/recall, durable queues, schema
migrations, generation manifests, retrieval controls, dimensions migration,
snapshots, installer rollback, all/default/individual profile selection,
activation, startup compatibility repair, profile isolation, Workshop and
Obsidian review remain. Existing parity matrices still describe native variants
and OpenClaw-only surfaces; this incremental port does not erase those limits.
No productive model selection, profile or memory is changed.
Builds, native platform execution, signing, publication and local activation are
separate states. Fresh results belong in `hermes-7.12.60-verification.md`.

## Efficiency proposals — not implemented

1. `_jsonl` parses entire journals before `detect_patterns` keeps 500 entries.
   A bounded reverse tail/validated offset index avoids historical parsing and
   allocation. Preserve malformed-line and last-valid-record semantics.
2. Cluster centroids are recomputed from all member vectors at each append.
   Running sums/counts remove repeated summation; test floating-point and
   cluster-boundary equivalence before applying.
3. Coordinate compaction with existing writer ownership rather than only
   retrying conflicts; benchmark a bounded maintenance window and capture delay.

These reduce local CPU/I/O or repeated DB work, not necessarily LLM token volume:
the first two paths are already deterministic. Lower model cost is not fewer
tokens, and timeout changes are not acceleration. User decision required.
