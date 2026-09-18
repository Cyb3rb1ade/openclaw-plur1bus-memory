# Known issues and verification limits

Baseline: **7.12.61**, reviewed at
`c381fd57fd80df193bc615f405704132dd89884e` on 2026-09-18. This is the canonical
current issue document; the root `KNOWN-ISSUES.md` points here.

**Reproduced** means an isolated execution was performed during this review.
**Static** means the behavior follows from the inspected code path but no
production exploit or delivery was tested. **Coverage limit** identifies what
the available evidence does not establish. None of the findings below is fixed
by rewriting documentation.

## Reranker order can be lost during global merge

**Status: reproduced.** The runtime wraps even one source in
`runMergedNamespaceRecall`. The child pipeline accepts the reranker's ordering
but retains the old numeric scores. `mergeNamespaceRecallResults` sorts by
those scores, potentially restoring the original order.

The isolated test used two synthetic, authorized cards and real pipeline/merge
functions under Node 22.23.2. Their scores were approximately 0.9091 and 0.6667:

```text
Before reranking: A, B
Stub reranker:    B, A
Global merge:    A, B
```

There was no external inference or real database. This confirms an ordering
contract failure, not a measured universal decline in recall quality. The
historical Jina sigmoid/ONNX fixes addressed provider scoring and do not resolve
this later merge behavior. Do not treat "reranker executed" as proof of final
order. Sources: [runtime wrapper](../index.js),
[pipeline and merge](../lib/recall-pipeline.js).

## Critical-push batches can exceed the daily limit

**Status: reproduced.** `runClassifier` evaluates several candidate cards
against the same persisted daily count, then increments it in the later push
loop. With five eligible synthetic user cards, a deterministic `person`
classification and `maxPerDay: 3`, it produced five `pushMessages`.

The test had no external sender: **zero messages were actually delivered**.
The defect is in admission/accounting within a batch, not evidence that every
real installation has delivered excess pushes. Do not rely on `maxPerDay` as a
hard batch limit at this version. Disabling `criticalPush.enabled` and verifying
that the corresponding job is inactive is an operational option until fixed.

Sources: [job](../lib/jobs/critical-classifier.js),
[push decision](../lib/critical-push-classifier.js),
[counter](../lib/critical-push-state.js).

## Dry-run does not uniformly suppress every side effect

**Status: static, path-specific.**

- [Daily consolidation](../lib/jobs/daily-consolidation.js) calls `purgeExpired`
  even when its `dryRun` option is true. A caller must not assume it only reads
  the database.
- [Reminder dispatch](../lib/jobs/reminder-dispatch.js) guards its queue-state
  mutation with `dryRun`, but an explicitly provided webhook or host callback
  can still deliver through the direct library path. The normal index wiring
  does not pass this dry-run option; this is not a claim that the regular
  command offers a safe delivery preview.

These observations were not tested against real reminders, webhooks or cards.
A repair should guard each effect, not merely rename a flag.

## Direct host card reads differ from recall

**Status: static contract boundary.** The host memory search adapter uses a
restricted private-agent search. Its direct card-read path uses `getCard`
without reproducing all contextual ACL, lifecycle and epistemic gates from the
recall pipeline. A prior search filter must not be described as a universal
read guarantee. Exploitability depends on the host's exposure and identity
contract; no cross-user production exploit was attempted.

Source: [host adapter](../lib/setup/memory-host-runtime.js).

## Emotion Tier 2 is keyword-based

**Status: implementation limit.** [tier2-transformer.js](../lib/tier2-transformer.js)
currently implements keyword scoring rather than loading an emotion ONNX
model. Tier 1 is lexical; Tier 3 can use an available chat-LLM route. The local
transformer embedding/reranking providers elsewhere in the package are real
and are a different feature. Emotion names and scores do not establish human
feelings or calibrated psychological judgments.

## Deletion, history and cross-store consistency

**Status: designed boundaries and failure modes.**

- Soft deletion plus tombstones prevents active recall and normalized identical
  re-ingestion in the bound scope. It is not full erasure from Neo journals,
  archives, exports, mirrors and backups, nor a paraphrase detector.
- Safe version replacement writes the replacement first, then supersedes the
  old row. LanceDB, JSONL journals, graph and vault do not share one transaction;
  a partial failure can require reconciliation and leave repairable forks.
- Missing versus corrupt tombstone state has deliberately different handling.
  Corruption can block writes rather than silently permit resurrection.
- Agent-private memories are agent-bound across workspaces. Automatic capture
  must not be advertised as per-workspace isolation.

Sources: [safe update](../lib/safe-update.js),
[tombstones](../lib/tombstone.js), [database](../index.js),
[ACL](../lib/acl-middleware.js).

## Platform and runtime coverage

The dated macOS / Node 22.23.2 suite run completed with **4,684 passed,
0 failed, 76 skipped** (4,760 tests, 849 suites; about 362.6 seconds).
Syntax checks passed. `npm audit --omit=dev` reported zero known advisories
at that time. These are results for the reviewed source, not evergreen claims.

Most skips concerned stable directory-file-descriptor capabilities unavailable
on that platform; others concerned a Bash-4 deployment prerequisite. Named
namespace, shared-pool and migration paths that were skipped are not verified
by a flat-layout test. A skip is not a pass and is not automatically a defect.

The package declares OpenClaw >=2026.8.1 and builds against 2026.8.2. Dated
compatibility records describe additional hosts. The review did not rerun every
host matrix, live delivery, remote provider fallback, long-running shutdown,
model migration, installed UI or personal production data. A health card alone
is not proof of working inference: the host vector-availability probe currently
uses a capability indicator rather than a live search.

Sources: [compatibility](compatibility-openclaw.md),
[host adapter](../lib/setup/memory-host-runtime.js),
[CI](../.github/workflows/ci.yml).

## Quality still requires an end-to-end evaluation

Passing unit and integration contracts does not establish retrieval precision,
recall coverage, truthful answers, prompt-injection resistance or beneficial
long-term adaptation. Ranking combines heuristics from different retrieval
paths. Logs and optional caches can contain query, memory or generated response
text; prompt-free cache keys do not imply content-free storage or logging.

A useful evaluation separates capture coverage, authorized retrieval, temporal
selection, final prompt inclusion, answer fidelity and delivery. Include
conflicting dates, role attribution, negation, forgotten content and old
instructions. Do not transfer historical latency measurements to a new machine
or provider without measurement.

## Historical findings and evidence

Earlier issue files mixed completed fixes, local deployment incidents and
release-specific backlog. They remain available at the reviewed snapshot:

- [Root backlog and laboratory observations](https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory/blob/c381fd57fd80df193bc615f405704132dd89884e/KNOWN-ISSUES.md).
- [Older issue/fix list](https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory/blob/c381fd57fd80df193bc615f405704132dd89884e/docs/known-issues.md).
- [Dated audit records](audits/) and [release history](../CHANGELOG.md).

An older "fixed" label applies to that specific finding, not to every later
code path with a similar name. Conversely, an old backlog item has not been
silently declared fixed just because it is absent from the current reproductions.
