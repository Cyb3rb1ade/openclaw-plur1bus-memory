# Feature-Cron Config Timeout Design

**Date:** 2026-07-30  
**Status:** Approved design, pending written-spec review

## Context

`loadFeatureCronConfig()` invokes:

```text
openclaw gateway call config.get --json
```

with a 15-second child-process timeout. During the PLUR1BUS 7.1.7 live
deployment, the same call completed in approximately 12.5 to 18 seconds.
`spawnSync()` therefore returned `ETIMEDOUT` with status 1 in the setup runner,
even though the gateway was healthy and returned a valid configuration when
allowed to finish. The runner failed closed and changed no cron jobs.

## Decision

Use a 30-second timeout only for the `config.get` call in
`loadFeatureCronConfig()`.

This is the narrowest change that covers the measured live latency while
preserving the existing failure bounds for:

- CLI availability checks;
- agent discovery;
- cron listing;
- cron creation and editing.

No retry is added. A retry could make one setup attempt take 30 seconds while
still issuing a second equivalent gateway request. The shared OpenClaw CLI
wrapper also keeps its existing default because raising it would affect every
installer and repair script.

## Behavior

- A valid configuration response received within 30 seconds proceeds through
  the existing source/runtime configuration validation.
- A timeout, non-zero exit, malformed JSON, invalid snapshot, or invalid shape
  continues to fail closed with no cron mutation.
- Runtime cron schedules, delivery configuration, model routing, and thinking
  policy are unchanged.
- PLUR1BUS 7.1.7 remains immutable. The fix is a follow-up change for the next
  release.

## Tests

Add a regression test around the real `loadFeatureCronConfig()` boundary. The
injected OpenClaw CLI double records the requested timeout and supplies a
literal valid snapshot. Before the implementation change, the test must fail
because it observes 15,000 ms; afterward it must observe 30,000 ms and return
the unchanged source/runtime objects.

Run:

```bash
node --test tests/feature-cron-bootstrap.test.js
npm run lint
npm test
```

## Success Criteria

- Only the `config.get` timeout changes from 15,000 to 30,000 ms.
- The regression test demonstrates a red-green cycle.
- Existing fail-closed tests remain green.
- The full project suite and CI pass.
- The change is delivered through a separate branch and pull request.
