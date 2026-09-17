# Hermes 7.12.60 efficiency follow-up

Baseline: `9797191a29adfbe9496b57ae246eeb140278b592`.
The user approved the three proposals, with prompt compaction rather than an
indefinite quiet-period deferral. No provider/model, schema, retention policy,
semantic consolidation schedule, context budget or public version is changed.

## Implementation and quality invariants

1. **Bounded journal tail:** only native `detect_patterns` changes its reader.
   It still consumes the last 500 valid JSON objects **before** user/content
   filtering, in chronological order. Read backwards in 64 KiB chunks and decode
   complete LF segments; preserve malformed-record skipping, CRLF/CR/Unicode
   line separators and valid EOF records without a trailing newline. No history
   is deleted. Other readers, especially thread-state replay, remain unbounded.
   A single huge/no-LF segment may need more I/O; correctness wins over a hard
   byte cap. Concurrent appends beyond the initial file size wait for the next
   scan; detected truncation fails visibly rather than publishing partial data.
2. **Running cluster sums:** maintain sums/counts instead of resumming every
   member on every append. For threshold/zero/tie decisions within a conservative
   1e-10 margin, recompute using the exact previous summation and strict `>` tie
   rule. This guard is for the private bounded 500 x 128 nonnegative unit-vector
   algorithm, not a generic unbounded vector API. No embedding model, dimension,
   threshold, record selection or saved pattern format changes.
3. **Prompt physical compaction:** acquire the existing process/thread writer
   lease immediately on request, then reopen/revalidate the exact generation
   and run optimize. No new idle schedule and no full-operation sleep before
   the first attempt. Release the lease after each attempt, including errors,
   before any retry backoff. Acquisition uses the existing overall retry budget;
   exhaustion reports `writer_busy`, not success or a silently deferred job.
   `writerWaitMs` reports acquisition time. Existing ordinary writer behavior
   remains blocking/reentrant. Reads do not acquire this lease.

Physical LanceDB fragment compaction does **not** shrink prompt text or directly
save LLM tokens. Semantic/context compaction can, but its schedule is untouched.
An executing synchronous optimize cannot be safely cancelled at the acquisition
deadline. Cooperating writes wait while it runs, potentially across agents
sharing the same data root. External writers that ignore the lease can still
conflict; the existing bounded conflict retry remains as a fallback. No hard
real-time scheduling or cross-process fairness guarantee is claimed.

## PR scope

The two measured proactive inefficiencies are in the Hermes Python adaptation.
OpenClaw already has a bounded journal reader and a different, seed-based cluster
algorithm with a once-per-cluster centroid. Applying these Python changes to its
JS implementation would not be a faithful optimization. The focused PR targets
the Hermes branch rather than introducing the entire port or a new clustering
algorithm into OpenClaw main. Existing upstream reports #150/#155 are unaffected.

## Verification

New tests were RED before implementation. Differential selection tests cover
randomized vectors, exact/near ties and threshold boundaries. Journal tests
cover malformed/non-object entries, Unicode, long records, partial EOF, and
measured 64 KiB I/O for a >1 MiB history with the needed suffix.
Coordination tests cover real cross-process lock contention, reentrancy,
bounded acquisition, writes waiting/resuming, lease release before backoff,
and real LanceDB row preservation. All writes use disposable test homes.

`scripts/benchmark-hermes-proactive.py` compares the pinned pre-optimization
implementation with the candidate on 100,000 synthetic records, verifies exact
saved outputs and measures the whole pattern-detection operation (five repeats).
No end-to-end model/token savings are inferred from this local CPU/I/O workload.

Local benchmark (macOS ARM/Python 3.12): 6,988,890 journal bytes, 100,000
records, identical saved outputs; median whole detection 329.815 ms before,
7.982 ms after (about 41x for this synthetic workload). Near-boundary clustering
deliberately falls back to the old calculation and may show little speedup.

Final suite/platform results and PR link will be added after verification.
Source integration is separate from installing/restarting a productive Hermes
instance. No productive data or active plugin files are modified by these tests.
