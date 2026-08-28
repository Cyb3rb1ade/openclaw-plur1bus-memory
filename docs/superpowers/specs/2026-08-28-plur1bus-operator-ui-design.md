# PLUR1BUS Operator UI Design

## Purpose

PLUR1BUS 7.5.0 adds an operator-facing Control UI for the exact
OpenClaw `2026.8.1-beta.3` plugin runtime. It makes memory health,
workspace policy, feature dependencies, provider readiness, and the
copy-on-write re-embedding state machine visible without exposing memory
content, filesystem paths, credentials, SecretRef identifiers, or raw error
messages.

The workspace policy default remains **enabled**. An absent policy record is
not an error and changes none of the existing behaviour.

## Beta-3 Capability Boundary

The published Beta-3 Control UI tab contract is deliberately a sandboxed
external frame. Its signed plugin-tab cookie grants only `operator.read` and
is accepted only for `GET` and `HEAD`. It cannot safely convey a Gateway token
or write/admin scope to plugin JavaScript. PLUR1BUS therefore must not add a
POST form, a token-bearing URL, a `postMessage` escape hatch, or a second
credential store to make the tab interactive.

The UI has two safe planes:

1. The PLUR1BUS tab is a read-only, `no-store`, CSP-locked dashboard.
2. Mutations use existing public OpenClaw interfaces with their declared
   scope: typed session action/RPC for workspace policy, the host Config and
   Secrets pages for feature settings and credentials, and the existing
   re-embedding RPC/CLI workflow for plan/apply/resume/switch/rollback.

This is capability detection, not a version-string workaround. If a future
OpenClaw release adds a scoped tab-to-action bridge, PLUR1BUS may add controls
only after the bridge proves both actor identity and the action's declared
operator scope.

## Read Model

`buildControlPlaneProjection()` emits a closed schema version 2. It has no
generic object spreading and accepts only allow-listed primitives.

### Memory Health

The projection includes:

- active embedding provider/model/revision/fingerprint/dimension;
- LanceDB state (`ready`, `degraded`, or `unavailable`), configured namespace
  identities and dimensions;
- card counts grouped by private agent and physically isolated workspace/user
  partitions, never rows or memory fields;
- used bytes below the PLUR1BUS data root and whether the bounded scan was
  complete;
- the most recent *health probe* failure as `{ component, code }`, never an
  exception message, path, request, or credential.

The health inspector opens only existing, non-symlinked LanceDB directories in
read-only mode. It validates every directory key, caps inspected partitions and
filesystem entries, coalesces concurrent requests, and has a short TTL. A
failed health probe degrades only the dashboard; it never changes memory data
or blocks a normal OpenClaw turn.

### Workspace Matrix

The matrix shows the default `enabled` policy plus durable override records
keyed by safe agent IDs and canonical, non-path workspace principals. It also
shows the effects of disabling a workspace: automatic capture, automatic
recall/injection, embedding, reranking, Skill Miner, workspace Cron,
workspace Obsidian work, and workspace background maintenance pause. It makes
clear that disabling neither deletes cards nor affects other agents or
workspaces.

The tab's action text links to the trusted session action/CLI path; it does
not pretend that a read-only iframe can toggle a policy.

### Feature Cards

Cards cover Capture, Recall, Skill Miner, Feature Cron, REM, Obsidian Bridge,
and Reranker. Each card has a closed label, configured/effective state,
dependency/reason, and a safe configuration route. Feature settings point to
OpenClaw Config; API-key changes point to OpenClaw Secrets. The existing host
configuration audit and PLUR1BUS destructive-operation audit remain the only
audit surfaces. The UI never accepts or displays a secret.

### Re-Embedding Wizard

The tab renders the durable migration state as an explicit workflow:

`Dry run -> estimate -> validate target fingerprint -> apply/checkpoint ->
validate -> switch -> rollback plan`.

It renders the existing redacted plan/migration receipt, including row totals,
byte estimate, progress, validation state, and safe failure code. It never
changes dimensions implicitly. Any target change must pass the current
hash-bound `operator.admin` plan/confirmation/apply/validation/switch process;
the page routes an operator to that official control surface rather than
performing a hidden write.

## Rendering and Security

The HTML renderer uses only escaped, server-rendered values and local CSS. It
does not use JavaScript, forms, `fetch`, external assets, inline event
handlers, or user-controlled URLs. It retains:

- `Cache-Control: no-store, max-age=0`;
- `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline';
  frame-ancestors 'self'; base-uri 'none'; form-action 'none'`;
- `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`;
- `GET, HEAD` only with `405` for every mutation method.

All output is rendered from the closed projection. Tests use sentinel values
to prove no secret literal, SecretRef identifier, memory text, path, command,
or raw error reaches either JSON or HTML.

## Failure and Lifecycle Rules

- A missing control-tab capability leaves the read-scoped Gateway status
  method available and logs one redacted warning.
- Health scan failure is visible as a stable code and does not affect the
  data plane.
- A missing mutation capability produces a clear capability error through the
  appropriate typed runtime; no fallback to a plugin HTTP write exists.
- Exactly one route, descriptor, and status method register per plugin load.
- Reload/shutdown creates no timers, listeners, or open health scan handles.

## Acceptance Tests

Unit and packed-runtime validation prove:

- schema-v2 projection rejects unknown/sensitive fields and preserves prior
  schema-v1 consumers where applicable;
- cards, workspace matrix, storage, health state, and migration steps are
  rendered without secrets or content;
- a disabled workspace appears as an override while the default remains on;
- every feature card explains dependency state and safe write route;
- all iframe mutation verbs remain `405`;
- an actual isolated Beta-3 gateway registers and serves the tab once;
- actual LanceDB counts/storage are read from the lab volume and do not create
  a table or write a card;
- typed policy actions, re-embedding RPC, Config, and Secrets paths remain the
  only mutation routes.

