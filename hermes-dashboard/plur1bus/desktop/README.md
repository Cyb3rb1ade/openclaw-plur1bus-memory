# Native Hermes Desktop entry

The optional `--desktop` installer flag installs `plugin.js` into the supported
`HERMES_HOME/desktop-plugins/plur1bus/` runtime-plugin directory and includes the
existing dashboard backend. It does not patch or rebuild Hermes itself.

Open **PLUR1BUS** from the left navigation, status bar, or command palette. On
current Hermes Desktop, the sidebar entry targets the contributed `/plur1bus`
route; compatible older hosts fall back to a native workspace. Requests use
Hermes’ authenticated, profile-aware `ctx.rest` transport for the PLUR1BUS
route namespace. Runtime-plugin discovery must be supported by the
installed Hermes Desktop version.

The view includes:

- Memory status, embedding model/dimensions and reranker configuration.
- An authenticated, paginated memory browser with literal substring search,
  lifecycle-status filter and expandable content/metadata. It reads only the
  server-selected scope and never embeds, creates, migrates or edits memories.
  Content previews are bounded to 32,768 characters; originals stay unchanged.
- Workshop proposal inspection, revision-bound approval and profile-wide skill
  publication. Each write follows a reviewed preview and explicit confirmation.
  Publishing is not execution/activation of the generated skill.

Desktop's SDK does not forward custom headers. A separate native JSON action
route therefore requires the host-issued session-token header or an explicitly
presented, host-verified OAuth bearer, rejects browser Origin/Fetch-Metadata
headers and reuses the exact session/profile/scope/writer/revision-bound one-use
nonce. Cookie authentication alone cannot use it. Existing web mutation routes
retain their origin and custom-header checks unchanged. No auto-retry on writes.
Unsupported authentication/backend versions visibly remain read-only.

Restart Hermes Desktop after installing/updating the plugin. The installer
does not patch or rebuild Hermes. Current Hermes registers a native route and
sidebar contribution; older SDKs can fall back to `host.openWorkspace` when
available.

The host can disable the entry in Settings → Plugins. Switching profiles or
connections remounts the view and discards outstanding responses; refreshes are
bounded and stale responses cannot replace newer data.

## Deliberate boundaries

This is not a copy of OpenClaw's entire dashboard. Model preparation,
Obsidian imports, physical optimization and maintenance remain in the native
operator CLI (`plur1bus-hermes-operator --help`) and existing controls. They need
their own source/destination, backup, licensing and writer-quiescence checks;
there is intentionally no browser endpoint for arbitrary paths/config/commands.
Background mining and generated-skill execution are not triggered merely by
opening the page. Existing partial host parity remains documented in the audit
matrix; this desktop integration does not turn it into full OpenClaw parity.

## Provider selection and dimension migration

Open **Provider & Dimensionen → Provider-Einstellungen öffnen**. Embeddings
support the pinned local-ONNX Jina v5 Nano backend, local-transformers,
OpenAI-compatible endpoints and oMLX. Reranking supports local-transformers,
OpenAI-compatible endpoints, Cohere, oMLX and disabled. Model availability is
not implied by a provider being selectable. Local model preparation remains
explicit; credentials are environment-variable references, never raw API keys.

Every change requires a native authenticated, profile/config-bound preview
and a single-use confirmation (five-minute expiry). Endpoint changes warn
about sending memory text and possible costs. Browser cookies/origins cannot
invoke these native actions. A profile switch clears the form and review.

- Reranking: stop Memory runtimes, run a fail-closed synthetic provider test,
  back up the profile config and atomically save only a PLUR1BUS retrieval
  override. The existing embedding configuration is preserved. Restart the
  Memory runtime after saving; the status is configured state, not a live
  inference availability assertion.
- Embeddings/dimensions: stop Memory runtimes sharing this data root, then
  preview, explicitly start backup plus staged re-embedding, review validation,
  and separately confirm activation. All vectors are recomputed from original
  text. No padding/truncation or silent schema-width edit is performed.
  The complete source DB is copied to `state/<agent>/retrieval-backups/` before
  staging. The source and earlier generations remain intact. Activation also
  compares every non-vector field and refuses changed sources or active leases.
  Successive migrations start from the certified active generation, including
  captures added since the first migration. Rollback restores the previous
  pointer; the existing operator CLI can recover interrupted activation.

Jobs run outside HTTP request timeouts and never auto-retry failed writes.
Reopening settings recovers the latest job in the current backend process.
After a backend restart, review the same target again to resume its deterministic
staging checkpoint if the source is unchanged. Incomplete source copies are
retained but never labelled complete backups. No job ends other processes,
deletes old generations or downloads the pinned ONNX model. Empty or custom
namespace stores that cannot satisfy the existing migration contract fail closed.

Local acceptance uses temporary LanceDB data for writes; productive QA opens
settings/previews only, without approving a provider change or migration.
# Profile-safe installation

Hermes Desktop's disk-plugin root is profile-dependent. For the root home and
all **existing** profiles, use `scripts/install-hermes-plugins.sh --hermes-home
/absolute/root/home --desktop-all-profiles` (plus the usual installation flags).
This distributes the UI without changing other profiles' memory-provider
configuration. After creating a profile, repeat this option or install with
`--desktop --hermes-home /absolute/root/home/profiles/name` for that profile.

The plugin matches the selected connection and profile with
`host.profileRoutes()`. The plugin’s REST endpoint must confirm the routed
profile, and subsequent requests include `expectedProfile` as an assertion.
The backend derives the actual home from the host and never selects it from
a client-supplied value. On hosts with plugin RPC support, regular settings
can also use the session-controlled `host.requestProfile()` route for an
authenticated local secondary profile. Otherwise hosted profiles with no
write identity stay read-only.

Save an optional Jev API key in **Hermes Settings → Memory → PLUR1BUS**. To
enable Jev, select **Automatic (Jev)** under **Storage mode** on the PLUR1BUS
page. This lets Jev classify eligible new capture text at `api.typesafe.ai`.

Memory navigation requires a successful, profile-bound capability response
reporting `memoryProviderEnabled: true`. An unavailable route (including HTTP
404 when a shared backend did not mount the plugin router) is unknown, not an
activation grant. The independent **PLUR1BUS: Check Desktop compatibility**
command remains discoverable even when memory navigation is hidden. Only a
previously confirmed active entry for that exact connection/profile may survive
a transient probe failure; memory data and actions remain fail-closed until
their handshake succeeds. Connection or profile changes recheck the active
identity, never borrow another profile's activation and discard late results; a
15-second check reconciles externally changed activation without probing
inactive profiles.
