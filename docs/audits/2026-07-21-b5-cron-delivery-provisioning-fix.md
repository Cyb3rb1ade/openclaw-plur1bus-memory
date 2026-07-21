# B5 Cron Delivery Provisioning Fix Receipt

Date: 2026-07-21

Branch: `fix/high-mid-audit-findings`

Scope: BUG-04, BUG-05, FA-08

## Disposition

- **BUG-04: CLOSED.** Outbound delivery uses a concrete binding peer or
  effective `defaultTo`, never the inbound sender allowlist (`allowFrom`).
- **BUG-05: CLOSED.** Provisioning loads exactly one successful, parseable,
  valid `config.get` snapshot for JSON5/path/default resolution and fails
  closed on invalid or explicitly missing accounts, wildcard targets, or
  loader errors without reflecting configuration payloads; omitted accounts
  inherit only the effective default account/defaultTo route.
- **FA-08: CLOSED for cron provisioning.** All seven documented feature
  handlers now have explicit owner-gated job specifications with their
  required schedules, timezone, delivery, agent, and session contracts.

No PLUR1BUS feature handler or feature behavior changed.

## Corrected contract

The provisioner can create exactly seven job types, each only behind its raw
owning gate: `persona-evolve`, `afterthought`, `consolidate-daily`,
`classify-recent`, `rem-dream`, `skill-miner`, and
`discover-semantic-links`. Every created job has an exact agent target and an
isolated session. Only `afterthought` and `classify-recent` announce, and only
after one concrete delivery route has been validated.

Delivery targets come from a concrete effective binding peer or inherited
`defaultTo`. Sender allowlists are ignored. Disabled/missing accounts,
wildcards, last/default placeholders, OpenClaw redaction markers, Telegram
zero ids, unsupported providers, case-colliding agents, and conflicting
candidate routes all make the route ineligible. Every safe existing candidate
must agree on channel, target, and account. Unsafe owned delivery jobs are disabled and changed to
`--no-deliver`; non-delivery jobs are always pinned to `--no-deliver`.

Existing-job identity requires the exact case-sensitive agent plus either the
exact canonical name or exact first command line. Missing-agent and wrong-agent
jobs are not migrated.

## Changed files

- `lib/setup/feature-cron-plan.js`
- `scripts/setup-feature-crons.mjs`
- `tests/feature-cron-plan.test.js`
- `tests/feature-cron-bootstrap.test.js`
- `README.md`
- `openclaw.plugin.json`
- `.superpowers/sdd/progress.md`
- `docs/audits/2026-07-21-b5-cron-delivery-provisioning-fix.md`

## TDD evidence

Focused RED cases were observed before implementation for:

- sentinels exposed after Telegram prefix stripping;
- a delivery-less argument plan falling back to announce/account flags;
- end-to-end unsafe owned delivery edit ordering;
- Telegram `0`/`-0` targets;
- out-of-range cron literals while retaining valid Croner steps;
- disagreement between PLUR1BUS and non-PLUR1BUS delivery candidates;
- case-colliding ownership/name/command identities;
- unsafe manual delivery hints;
- invalid explicit defaults and explicitly missing accounts;
- the provider-independent OpenClaw `***` redaction sentinel.
- missing, option-like, invalid, or redacted manual agent/account arguments;
- exact ownership in the exported legacy bare-name planner.

Each causal test passed after its minimal implementation. The combined focused
gate passed 116/116. The adjacent configuration/default-LLM contract gate
passed 45/45. The serial deploy-integrity, symlink bootstrap, default-LLM
caller/runtime, and focused cron command exited 0. `npm run lint`, manifest JSON
parsing, and `git diff --check` passed.

## Security notes

Configuration loader failures return fixed reason/code metadata only. Snapshot
stdout/stderr, invalid snapshots, validation issues, paths, and thrown messages
are not reflected. The provisioner performs no cron read or mutation after a
configuration loader failure or when all raw gates are off.

The add/edit commands contain no `--model`, fallback, auth, token, API-key, or
credential override. OpenClaw's configured default LLM and per-agent
credentials therefore remain in force.

## Post-implementation specification review closure

The first independent B5 specification review reported Critical 0 / Important
7. All seven findings were reproduced before correction and are closed:

| Finding | Closure |
|---|---|
| I1 Croner-invalid schedules passed the eligibility filter | Conservative field grammar now rejects empty ranges, bare modifiers, literal steps, invalid names, and out-of-range values while retaining documented wildcard/range steps and JAN–DEC/SUN–SAT forms. |
| I2 Runtime routing ignored non-Telegram bindings and treated explicit empty accounts as omitted | Every relevant non-ACP binding must agree on channel; only an absent own `accountId` property inherits the effective default. |
| I3 Existing delivery mode comparison was normalized | Existing seeds require exact case-sensitive `mode === "announce"`. |
| I4 Only the first owned job was processed | Multi-agent and legacy planning enumerate every exact owned match; every unsafe duplicate is migrated even when a safe duplicate satisfies idempotency. |
| I5 Missing delivery mode on non-delivery jobs was treated as correct | Only missing delivery or exact `mode: "none"` is retained; every other delivery value is removed. |
| I6 Bare `t.me/<handle>` was rejected | The same conservative Telegram handle/path validator now accepts bare, http(s), and optional-www t.me forms while rejecting sentinels and extra paths. |
| I7 Manifest documentation omitted concrete ownership gates | `featureCronSetup.description` now lists all seven owner gates, the `rem-dream` merging gate, and peer/defaultTo-not-allowFrom delivery policy; a manifest regression test pins it. |

Post-review focused gate: 122/122 across 20 suites, with no failures or skips.
The serial adjacent configuration, runtime-config, default-LLM contract/caller,
default-LLM runtime, and deploy-integrity gate exited 0. Lint, manifest JSON
parsing, and the diff whitespace check also passed.
