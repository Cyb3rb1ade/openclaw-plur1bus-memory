# Hermes Desktop integration — local acceptance

2026-09-05, native Hermes Desktop `0.21.0 ee5b5ec`, extending the previously
released `7.12.0-hermes`. This change is a **local candidate**, not a new published
release or a claim of complete OpenClaw parity.

## Implemented surfaces

| Function | Native Desktop | Boundary |
| --- | --- | --- |
| Open PLUR1BUS | Bottom status-bar button and command palette; closeable workspace tab | Uses public `host.openWorkspace`; no core patch, port or extra daemon |
| Profile/agent status | Active server-selected namespace, row count, embedding provider/model/dimensions, reranker | Configuration readiness is not a per-request model health check |
| Memory inspection | Literal text search, status filter, 20-row pages, expandable text and metadata | Authenticated; exact scope only, no vectors/internal provenance; no recall or mutations |
| Workshop | Proposal inspection, reviewed approval and publication | Session/scope/route/revision-bound one-use nonce; profile-wide publication warning; no automatic execution |
| Re-embedding / model preparation | Existing native operator CLI retained | Licensing, source/destination review, backup and quiescent-writer gates remain mandatory |
| Maintenance / Obsidian / background jobs | Existing controls, CLI and native workflows retained | Not duplicated as unrestricted browser commands or configuration writes |

## Root cause of the empty page

Hermes' compiled `ChatRoutesSurface` calls `useContributions(ROUTES_AREA)` but
discards its return value. Its separately read `contributedRoutes()` result is
memoized by the React compiler against other values, not the registry snapshot.
A runtime plugin can therefore add a visible sidebar link without entering the
rendered route table. Actual Computer Use testing reproduced this after hot
installation and again after reload; one successful reload was not a fix.

The final implementation removes the experimental native `/plur1bus` route and
uses the public workspace API. The button directly opens/re-fronts one stable
workspace id. Disposal closes the plugin's tab. An older host without this API
gets a disabled button and update hint. The web dashboard's separate URL is not
changed.

## Security review

- Browser-supplied profile, agent and filesystem paths never select data.
- Memory GET requires a verified actor in addition to host middleware. Input
  length/status/page bounds are checked. Apostrophes are escaped and substring
  matching treats wildcard/SQL-looking text literally. Only an existing exact
  table is opened, with the canonical scope predicate and bounded projection.
- Native mutation transport rejects Origin and Fetch-Metadata headers, requires
  a host-issued session token or host-verified explicit OAuth bearer (not only a
  cookie), JSON and an explicit action verb. It shares the existing nonce and
  evidence-validation implementation; browser origin/header guards are unchanged.
- No automatic retry of uncertain writes. Late results, disposed views and
  connection/profile changes are rejected in the frontend; mutation nonces also
  fail closed if the backend route changes.
- No arbitrary path/config/command execution API and no productive mutation for
  UI acceptance. Content is rendered as React text, not executable HTML.

## Verification

- Full Node suite: 4,287 tests, 4,211 passed, 76 skipped, 0 failed. The final
  workspace navigation change was additionally exercised by the focused native
  plugin harness and actual Computer Use.
- Python: 482 Hermes tests, 13 dashboard tests, 2 controls tests and 9 sidecar
  tests passed. Real temporary LanceDB tests prove filtering, literal search,
  pagination and unchanged row count.
- Native ESM behavior harness tests status failures, request ordering, scope
  changes, disposal, write-dispatch ownership, workspace opening and teardown.
- Installer regression suites, syntax/lint and whitespace gates passed.
- Computer Use on the actual installed app: real status, content search,
  pagination and detail expansion; default (61 rows) versus bernd/main (9,086
  rows); profile switching; repeated workspace open, close and reopen.
- Workshop buttons were exercised through the real UI using a clearly labeled,
  temporary synthetic transport: preview → approve, warning → publish, and an
  error state. API authentication/nonce gates were separately tested over HTTP.
  No real skill was approved/published. The synthetic transport was removed and
  the installed plugin compared with source before final acceptance.
- Found pre-existing live environment drift: huggingface-hub 1.24.0 conflicted
  with transformers 4.57.6; numpy 2.4.3 differed from the PLUR1BUS pin. Restored
  huggingface-hub 0.36.2 and numpy 2.2.0; `pip check` and actual offline Nano 768
  embedding plus BGE ranking passed. No model or memory migration performed.

The candidate was installed into the local venv and the existing plugin copies;
Desktop was restarted, the independent Telegram gateway was not restarted.
This is not a new end-to-end capture/recall certification of every gateway
process, and does not supersede the prior release's separate runtime acceptance.
