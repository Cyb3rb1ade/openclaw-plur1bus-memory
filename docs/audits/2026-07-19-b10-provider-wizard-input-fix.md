# B10 Provider-Wizard Input Fix Receipt

Date: 2026-07-19
Batch: B10 wizard-only portion
Finding: BUG-ADD-08; partial FE-ADD-07 receipt
Branch: `fix/high-mid-b10-wizard-input`
Fix base: `5aaabf7cd635ac561bd85c4fea643f49f65fe464`

## Outcome and scope

BUG-ADD-08 is fixed at the real interactive provider-wizard boundary. Invalid
advanced reranker input now emits a localized diagnostic and re-prompts. Only
an exact `a`, `b`, or `c` selects an advanced local model, and only the explicit
top-level choice `3` disables reranking. End-of-input after an invalid choice
exits nonzero without emitting final configuration JSON.

This receipt does **not** claim full FE-ADD-07 closure. Load-time timezone and
hour validation is deliberately owned by B11, where `index.js` still knows the
effective configuration path and can reject invalid values before registration
side effects. No `lib/time-window.js`, `index.js`, manifest, quiet-hours schema,
installer, dependency, or unrelated low-finding change is included here.

## Source-to-sink and restored invariant

The reachable defect was:

```text
advanced choice text
  -> trim
  -> charCodeAt(0) - 97
  -> any a/b/c prefix selects a model
  -> every other value returns provider=disabled
  -> main emits successful JSON and exits 0
```

Thus `x` silently disabled a configured feature, while `a-extra` silently chose
Alibaba. The restored invariant is that invalid input never changes feature
state: it either re-prompts or, if input closes, fails without a final config.

The wizard now compares the complete trimmed token against the exact accepted
set. The invalid-advanced diagnostic has dedicated German and English i18n
entries rather than reusing the misleading top-level `1..4` message. The input
helper also races each question against readline closure so EOF cannot leave an
unresolved promise and an accidental zero exit.

## TDD evidence

The realistic CLI fixture starts the actual wizard process, waits for each
visible prompt before answering, and parses only its final JSON. Node's internal
test-runner context is removed from the nested CLI environment so the child runs
as a normal program.

Before production edits, the calibrated causal RED was:

```text
$ node --test --test-concurrency=1 tests/provider-wizard-cli.test.js
tests 4; pass 1; fail 3; exit 1
```

The explicit-disable positive control passed. The three causal failures showed
that `x` did not re-prompt, `a-extra` was accepted by prefix, and EOF after `x`
exited zero with disabled JSON.

After the minimal implementation and EOF-boundary correction:

```text
$ node --test --test-concurrency=1 \
    tests/provider-wizard-cli.test.js \
    tests/provider-wizard.test.js \
    tests/provider-wizard-config.test.js \
    tests/i18n-setup-reranker.test.js \
    tests/i18n-coverage.test.js
tests 49; suites 5; pass 49; fail 0; duration_ms 1639.150644
```

The final change-aware owning gate additionally retained provider construction,
Local Transformers batching, runtime reranker configuration, null fallback, and
reranker-pipeline behavior:

```text
tests 69; suites 10; pass 69; fail 0; duration_ms 7374.632812
```

`npm run lint`, `node --check` for the changed script/test, and
`git diff --check` all exited zero.

## Bypass and preservation review

The real CLI fixture covers `x`, `a-extra`, `aa`, whitespace-only input, EOF,
exact `a`, exact `b`, exact `c`, explicit top-level disable, and the default
local BGE choice. All advanced model identifiers and emitted configuration
fields remain unchanged. Existing Cohere, embedding, provider normalization,
fallback, timeout, and candidate behavior is untouched.

Repository search found one advanced-choice sink in
`scripts/provider-wizard.mjs`; there is no second wizard path that maps invalid
advanced input to disabled state. The installer currently has no active call
into this wizard, so installer integration was not invented in this batch.

## Changed files

- `scripts/provider-wizard.mjs`
- `lib/i18n-dictionary.js`
- `tests/provider-wizard-cli.test.js`
- `tests/i18n-setup-reranker.test.js`
- this receipt

## Remaining joint work

B11 must validate every supported explicit timezone and direct hour-bound input
once during effective configuration loading, before any registering/mutating
API callback. Absent/falsy timezone compatibility remains local time. No new
quiet-hours production schema is implied. The formatter-cache low remains out
of scope. FE-ADD-07 closes only when this receipt and B11's time-configuration
receipt are both present.
