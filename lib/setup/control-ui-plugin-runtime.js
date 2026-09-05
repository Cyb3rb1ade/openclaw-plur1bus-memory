import {
  CONTROL_UI_ACTION_FIELD,
  CONTROL_UI_FORM_TOKEN_FIELD,
  RERANKER_CHOICES,
  readFormBody,
  writeResultText,
} from "./control-ui-write.js";

export const CONTROL_UI_GATEWAY_METHOD = "plur1bus.control.status";
import { randomBytes } from "node:crypto";

export const CONTROL_UI_PATH = "/plugins/memory-lancedb-namespaced/control";

const ACTIVE_REEMBEDDING_STATES = new Set(["running", "validating", "switching", "rolling_back"]);
const ACTIVE_MODEL_PREPARATION_STATES = new Set(["downloading", "validating"]);
const ACTIVE_REEMBEDDING_REFRESH_SECONDS = 5;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function setHeaders(response, contentType = "text/html; charset=utf-8", { allowForms = false, nonce = "", connectSrc = "" } = {}) {
  response.setHeader("cache-control", "no-store, max-age=0");
  response.setHeader("content-type", contentType);
  // form-action stays 'none' while the tab is read-only, so a page that cannot
  // change anything also cannot be made to post anywhere. The host embeds the
  // tab in an iframe sandboxed with allow-scripts only, which blocks native
  // form submission; a writable page therefore carries one nonce-bound script
  // that posts the form with fetch, and connect-src names exactly this host.
  const scriptSrc = nonce ? `script-src 'nonce-${nonce}'; ` : "";
  const connect = connectSrc ? `connect-src ${connectSrc}; ` : "";
  response.setHeader(
    "content-security-policy",
    `default-src 'none'; style-src 'unsafe-inline'; ${scriptSrc}${connect}frame-ancestors 'self'; base-uri 'none'; form-action ${allowForms ? "'self'" : "'none'"}`,
  );
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "SAMEORIGIN");
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeText(value, fallback = "—") {
  if (typeof value === "string" && value) return escapeHtml(value);
  if (typeof value === "number" && Number.isFinite(value)) return escapeHtml(String(value));
  return fallback;
}

function safeInteger(value, fallback = null) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function formatBytes(value) {
  const bytes = safeInteger(value);
  return bytes === null ? "not available" : `${bytes.toLocaleString("en-US")} B`;
}

// The health snapshot is served from a cache that refreshes behind the page,
// so the reader needs to know how old the numbers are.
function describeObservedAge(observedAt, nowMs) {
  const at = safeInteger(observedAt);
  if (at === null || at === 0) return "not observed yet";
  const seconds = Math.max(0, Math.round((nowMs - at) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min ago`;
}

function activeReembeddingRefreshSeconds(workflow) {
  const migration = asObject(asObject(workflow).migration);
  return ACTIVE_REEMBEDDING_STATES.has(migration.state)
    ? ACTIVE_REEMBEDDING_REFRESH_SECONDS
    : null;
}

function dashboardRefreshSeconds(status) {
  if (ACTIVE_MODEL_PREPARATION_STATES.has(asObject(status.modelPreparation).state)) {
    return ACTIVE_REEMBEDDING_REFRESH_SECONDS;
  }
  return activeReembeddingRefreshSeconds(status.reembeddingWorkflow);
}

function stateName(value) {
  return typeof value === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(value) ? value : "unknown";
}

function writeContext(value) {
  const context = asObject(value);
  const mode = context.mode === "reranker" || context.mode === "all" ? context.mode : "off";
  return {
    mode,
    reranker: mode !== "off",
    embedding: mode === "all",
    token: typeof context.token === "string" ? context.token : "",
    result: typeof context.result === "string" ? context.result : "",
    keyConfigured: context.keyConfigured === true,
    nonce: typeof context.nonce === "string" && /^[A-Za-z0-9+/=_-]{16,64}$/.test(context.nonce) ? context.nonce : "",
    // Compaction buttons are part of the full write surface only.
    compaction: mode === "all" && context.compaction && typeof context.compaction === "object"
      ? context.compaction
      : null,
  };
}

function formStart(write, action) {
  return `<form class="switch-form" method="post" action="${CONTROL_UI_PATH}">`
    + `<input type="hidden" name="${CONTROL_UI_FORM_TOKEN_FIELD}" value="${escapeHtml(write.token)}">`
    + `<input type="hidden" name="${CONTROL_UI_ACTION_FIELD}" value="${escapeHtml(action)}">`;
}

function renderResultBanner(write) {
  const text = writeResultText(write.result);
  if (!text) return "";
  const ok = write.result.startsWith("denied_") || write.result === "failed" ? "attention" : "complete";
  return `<div class="notice notice-result" role="status">${renderBadge(ok)} ${escapeHtml(text)}</div>`;
}

// The dashboard names the choice the running configuration expresses, so the
// active option can be marked without reading the config file itself.
function activeRerankerChoiceFromProviders(providers) {
  const reranker = asObject(asObject(providers).reranker);
  if (!reranker.provider) return "disabled";
  const match = RERANKER_CHOICES.find((choice) => (
    choice.provider === reranker.provider
    && (choice.model === null || choice.model === reranker.model)
  ));
  return match ? match.id : null;
}

function renderRerankerSwitch(write, providers) {
  if (!write.reranker) return "";
  const active = activeRerankerChoiceFromProviders(providers);
  const options = RERANKER_CHOICES.map((choice) => {
    const current = choice.id === active;
    const blocked = choice.needsKey && !write.keyConfigured;
    const label = `<span class="switch-label">${escapeHtml(choice.label)}</span><span class="switch-detail">${escapeHtml(choice.detail)}</span>`;
    if (current) return `<li class="switch-option is-current">${label}${renderBadge("current")}</li>`;
    if (blocked) {
      return `<li class="switch-option">${label}<span class="hint">Needs a key first</span></li>`;
    }
    return `<li class="switch-option">${label}`
      + `${formStart(write, "reranker.set")}`
      + `<input type="hidden" name="choice" value="${escapeHtml(choice.id)}">`
      + `<button type="submit">Switch</button></form></li>`;
  }).join("");
  return `<ul class="switch-list">${options}</ul>`;
}

function renderBadge(value) {
  const state = stateName(value);
  return `<span class="badge badge-${escapeHtml(state)}">${escapeHtml(state.replaceAll("_", " "))}</span>`;
}

function renderCountList(values, emptyMessage, { zeroHint = "" } = {}) {
  const valid = asArray(values).filter((entry) => asObject(entry) && safeInteger(entry?.cards) !== null);
  const entries = valid.map((entry) => `<li><code>${safeText(entry.id)}</code><strong>${safeInteger(entry.cards)}</strong></li>`);
  if (entries.length === 0) return `<p class="empty">${escapeHtml(emptyMessage)}</p>`;
  // Partitions that exist but hold nothing look like a broken counter; say
  // what the zeros mean instead of leaving the reader to guess.
  const allZero = zeroHint && valid.every((entry) => safeInteger(entry.cards) === 0);
  return `<ul class="count-list">${entries.join("")}</ul>${allZero ? `<p class="hint">${escapeHtml(zeroHint)}</p>` : ""}`;
}

// One "Compact" button behind each private partition. Only the full write
// surface renders it; the runner refuses ids the health scan did not list,
// so the form can only name what this very list shows.
function renderCompactionControl(id, write) {
  const status = asObject(write.compaction);
  const state = asObject(asObject(status.byPartition)[id]);
  const running = state.status === "running";
  const busy = typeof status.active === "string" && status.active.length > 0;
  let note = "";
  if (state.status === "done") note = `<span class="row-note">${escapeHtml(typeof state.summary === "string" && state.summary ? state.summary : "compacted")}</span>`;
  else if (state.status === "failed") note = `<span class="row-note">${renderBadge("attention")} compaction failed</span>`;
  const button = running
    ? `<button type="button" disabled aria-busy="true">compacting…</button>`
    : `<button type="submit"${busy ? " disabled" : ""}>Compact</button>`;
  return `<form class="row-form" method="post" action="${CONTROL_UI_PATH}">`
    + `<input type="hidden" name="${CONTROL_UI_FORM_TOKEN_FIELD}" value="${escapeHtml(write.token)}">`
    + `<input type="hidden" name="${CONTROL_UI_ACTION_FIELD}" value="compaction.start">`
    + `<input type="hidden" name="partition" value="${escapeHtml(id)}">`
    + `${button}</form>${note}`;
}

function renderPartitionList(values, emptyMessage, write = writeContext(null)) {
  if (!write.compaction) return renderCountList(values, emptyMessage);
  const entries = asArray(values)
    .filter((entry) => asObject(entry) && safeInteger(entry?.cards) !== null && typeof entry?.id === "string")
    .map((entry) => `<li><code>${safeText(entry.id)}</code><span class="row-tail"><strong>${safeInteger(entry.cards)}</strong>${renderCompactionControl(entry.id, write)}</span></li>`);
  return entries.length > 0 ? `<ul class="count-list">${entries.join("")}</ul>` : `<p class="empty">${escapeHtml(emptyMessage)}</p>`;
}

// Reranking is the one provider choice a reader cannot infer from anywhere else
// on this page: the feature card only says on or off, and Credential Readiness
// only says whether a key exists. Without this the operator cannot tell whether
// recall is being reordered by Cohere, by JinaAI, or by the local fallback.
function renderRerankerCard(providers, features, write = writeContext(null)) {
  const reranker = asObject(providers).reranker;
  const state = asObject(asObject(features).reranker);
  // The provider values are the ones the config schema accepts. An earlier
  // version of this card offered "jina" as a provider, which the schema
  // rejects: the Jina reranker is a local model, selected through
  // reranker.local.model with provider local-transformers.
  const guidance = `<p><code>reranker.provider</code> takes <code>local-transformers</code>, <code>cohere</code> or <code>disabled</code>. For a local reranker, <code>reranker.local.model</code> picks the model: <code>${escapeHtml(RERANKER_CHOICES[1].model)}</code> for JinaAI or <code>${escapeHtml(RERANKER_CHOICES[0].model)}</code> for BGE. Both run locally and need no key. <code>cohere</code> reads its key from <code>reranker.apiKey</code> or <code>reranker.apiKeyEnv</code>.</p>`;
  // With the switch list rendered the card carries four options and needs the
  // full row; as a status card it sits fine in the three-column grid.
  const cardClass = write.reranker ? "card card-wide" : "card";
  if (!reranker) {
    return `<article class="${cardClass}"><h3>Reranking</h3><p>No reranker is active. Recall returns candidates in raw similarity order.</p>
${guidance}${renderRerankerSwitch(write, providers)}</article>`;
  }
  const provider = asObject(reranker);
  const blocked = state.configured === true && state.effective === false;
  const note = blocked
    ? `<p>Switched on but held back: <code>${safeText(state.reason)}</code>. Recall falls back to raw similarity order until the runtime is available.</p>`
    : "";
  return `<article class="${cardClass}"><h3>Reranking</h3><dl><dt>Provider</dt><dd>${safeText(provider.provider)}</dd><dt>Model</dt><dd>${safeText(provider.model)}</dd>${
    provider.revision ? `<dt>Revision</dt><dd><code>${safeText(provider.revision)}</code></dd>` : ""
  }</dl>${note}
${write.reranker ? "" : guidance}${renderRerankerSwitch(write, providers)}</article>`;
}

function renderMemoryHealth(value, providers, features, nowMs = Date.now(), write = writeContext(null)) {
  const health = asObject(value);
  const observedAt = safeInteger(health.observedAt);
  const observed = observedAt
    ? `<time datetime="${escapeHtml(new Date(observedAt).toISOString())}">${escapeHtml(describeObservedAge(observedAt, nowMs))}</time>`
    : escapeHtml(describeObservedAge(observedAt, nowMs));
  const embedding = asObject(asObject(providers).embedding);
  const cards = asObject(health.cards);
  const namespaces = asArray(health.namespaces)
    .filter((entry) => asObject(entry) && safeInteger(entry?.dimensions) !== null)
    .map((entry) => `<tr><td><code>${safeText(entry.id)}</code></td><td>${safeInteger(entry.dimensions)}</td><td>${safeInteger(entry.rows, 0)}</td></tr>`)
    .join("");
  const lastError = asObject(health.lastError);
  const error = lastError.component && lastError.code
    ? `<code>${safeText(lastError.component)}:${safeText(lastError.code)}</code>`
    : "none";
  return `<section class="panel" aria-labelledby="memory-health-title">
<div class="section-heading"><div><h2 id="memory-health-title">Memory Health</h2><p>Aggregate-only LanceDB status; no memory card content is shown. Snapshot observed ${observed}; it is refreshed in the background, so this page never waits for a scan.</p></div>${renderBadge(health.status)}</div>
<div class="grid grid-3">
<article class="card"><h3>Embedding space</h3><dl><dt>Provider</dt><dd>${safeText(embedding.provider)}</dd><dt>Model</dt><dd>${safeText(embedding.model)}</dd><dt>Fingerprint</dt><dd><code>${safeText(embedding.fingerprint)}</code></dd><dt>Dimensions</dt><dd>${safeText(embedding.dimensions)}</dd></dl></article>
<article class="card"><h3>LanceDB</h3><dl><dt>Storage</dt><dd>${formatBytes(health.storage?.bytes)}</dd><dt>Scan complete</dt><dd>${health.storage?.complete === true ? "yes" : "no"}</dd><dt>Last health error</dt><dd>${error}</dd></dl></article>
<article class="card"><h3>Cards by agent</h3>${renderPartitionList(cards.byAgent, "No private agent cards observed.", write)}</article>
${renderRerankerCard(providers, features, write)}
</div>
<div class="grid grid-2"><article class="card"><h3>Cards by workspace</h3>${renderCountList(cards.byWorkspace, "No shared workspace cards observed.", { zeroHint: "These shared workspace partitions exist but hold no cards yet. A card gets there through /share <id>; recall still runs on each agent's private partition." })}</article><article class="card"><h3>Cards by user</h3>${renderCountList(cards.byUser, "No shared user cards observed.", { zeroHint: "These shared user partitions exist but hold no cards yet. A card gets there through /share <id> --user." })}</article></div>
<h3>Namespaces</h3><div class="table-wrap"><table><thead><tr><th scope="col">Namespace</th><th scope="col">Dimensions</th><th scope="col">Cards</th></tr></thead><tbody>${namespaces || "<tr><td colspan=\"3\">No namespace health data available.</td></tr>"}</tbody></table></div>
</section>`;
}

function renderWorkspaceMatrix(value) {
  const matrix = asObject(value);
  const effects = asArray(matrix.disabledWorkspaceEffects)
    .map((effect) => `<li><code>${safeText(effect)}</code></li>`)
    .join("");
  const rows = asArray(matrix.overrides)
    .filter((entry) => asObject(entry))
    .map((entry) => `<tr><td><code>${safeText(entry.agentId)}</code></td><td><code>${safeText(entry.workspace)}</code></td><td>${entry.enabled === false ? "off" : "on"}</td><td>${safeInteger(entry.revision, 0)}</td></tr>`)
    .join("");
  return `<section class="panel" aria-labelledby="workspace-matrix-title">
<div class="section-heading"><div><h2 id="workspace-matrix-title">Workspace Matrix</h2><p>Workspace policy is on by default. Only durable overrides are listed.</p></div>${renderBadge(matrix.defaultEnabled === false ? "disabled" : "enabled")}</div>
<div class="table-wrap"><table><thead><tr><th scope="col">Agent</th><th scope="col">Workspace</th><th scope="col">PLUR1BUS</th><th scope="col">Revision</th></tr></thead><tbody>${rows || "<tr><td colspan=\"4\">No workspace overrides. The default remains on.</td></tr>"}</tbody></table></div>
<div class="notice"><strong>When a workspace is off:</strong> automatic hooks pause only for that agent/workspace; stored cards remain intact and other workspaces are unaffected.<ul>${effects || "<li>No pause list available.</li>"}</ul><p>Use the typed workspace-policy action or CLI from the authenticated OpenClaw session surface to change an override.</p></div>
</section>`;
}

function renderFeatureControls(values) {
  const cards = asArray(values).filter((entry) => asObject(entry));
  const counts = { enabled: 0, degraded: 0, disabled: 0 };
  const rendered = cards.map((entry) => {
    const state = entry.effective === true ? "enabled" : entry.configured === true ? "degraded" : "disabled";
    counts[state] += 1;
    const purpose = typeof entry.purpose === "string" && entry.purpose ? entry.purpose : "";
    const dependencies = asArray(entry.dependencies)
      .map((dependency) => `<code>${safeText(dependency)}</code>`).join(" ");
    const reason = typeof entry.reason === "string" && entry.reason ? entry.reason : "";
    // Purpose and reason are rendered as text, not as a title attribute: a
    // hover is neither keyboard reachable nor reliably announced.
    const details = [
      purpose ? `<p class="feature-purpose">${escapeHtml(purpose)}</p>` : "",
      reason ? `<p class="feature-note"><span class="label">Blocked by</span> <code>${escapeHtml(reason)}</code></p>` : "",
      dependencies ? `<p class="feature-note"><span class="label">Needs</span> ${dependencies}</p>` : "",
    ].join("");
    return `<li class="card feature-card"><div class="card-heading"><h3>${safeText(entry.label)}</h3>${renderBadge(state)}</div>${details}</li>`;
  }).join("");
  const summary = `${counts.enabled} running, ${counts.degraded} blocked, ${counts.disabled} off`;
  return `<section class="panel" aria-labelledby="feature-controls-title">
<div class="section-heading"><div><h2 id="feature-controls-title">Feature Controls</h2>
<p>All PLUR1BUS features are opt-out: an absent switch means on, only an explicit <code>enabled: false</code> turns one off. <strong>Running</strong> is active, <strong>blocked</strong> is switched on but held back by a dependency, <strong>off</strong> is switched off. Changes are made in <a href="/config">OpenClaw config</a>; this tab is read-only.</p>
<p class="summary" role="status">${escapeHtml(summary)}</p></div></div>
<ul class="grid grid-3 card-list">${rendered || "<li class=\"empty\">Feature cards are not available.</li>"}</ul>
</section>`;
}

// Every credential the control-plane projection reports, with the exact
// config path an operator has to edit and a one-line purpose. The projection
// carries eight; showing only four left half of them invisible.
const CREDENTIAL_UI_DEFINITIONS = Object.freeze([
  ["embedding", "Embedding", "embedding.apiKey", "Turns text into vectors for storage and recall. Without it PLUR1BUS cannot write or search memories."],
  ["embeddingFallback", "Embedding fallback", "embedding.fallback.apiKey", "Used only when the primary embedding provider fails. Optional, but recall stops during an outage without it."],
  ["reranker", "Reranker", "reranker.apiKey", "Re-orders recall candidates for relevance. Optional; recall works without it, just less precisely."],
  ["merging", "Merging", "merging.apiKey", "Lets the model decide whether two similar memories describe the same fact."],
  ["knowledgePromotion", "Knowledge promotion", "schicht15.apiKey", "Promotes recurring findings into long-term knowledge."],
  ["skillMiner", "Skill Miner", "skillMiner.apiKey", "Derives reusable skills from past conversations."],
  ["criticalPush", "Critical push", "criticalPush.apiKey", "Sends urgent memory findings to the operator."],
  ["emotionTier3", "Emotion tier 3", "emotion.t3.apiKey", "Optional deep affective analysis of a conversation turn."],
]);

const CREDENTIAL_STATUS_HELP = Object.freeze({
  configured: "A value or reference is present. PLUR1BUS never reads it here, so this says nothing about whether the key is still valid.",
  host_route: "No key of its own, and none needed: this capability runs on OpenClaw's configured model route. Nothing is missing here.",
  missing: "Nothing is configured at this path, the runtime's default environment variable is unset, and there is no host route to fall back on. The feature that needs it stays off.",
  not_required: "This provider needs no key: a local model, or the capability is switched off.",
  optional: "Not switched on. This capability is optional, so nothing is missing.",
  invalid: "Something is configured but it is neither a string nor a recognised SecretRef. Fix the shape, otherwise the feature stays off.",
});

const CREDENTIAL_SOURCE_HELP = Object.freeze({
  plaintext: "The key sits directly in the config file. Works, but a SecretRef keeps it out of backups and diffs.",
  env: "Resolved from the environment variable named in apiKeyEnv at runtime.",
  env_default: "No config path is set; the runtime falls back to its default environment variable, and that variable is present.",
  store: "Resolved from the OpenClaw secret store.",
  file: "Read from a file on disk.",
  exec: "Produced by an external command at runtime.",
});

function credentialHelp(map, key, fallback) {
  const text = key && Object.hasOwn(map, key) ? map[key] : fallback;
  return escapeHtml(text);
}

function renderObsidianVault(value) {
  const vault = asObject(value) || {};
  const count = safeInteger(vault.configuredCount) ?? (vault.configured === true ? 1 : 0);
  const targets = `${count} target${count === 1 ? "" : "s"}`;
  // With path confirmation switched off the bridge acts on a configured target
  // without a receipt, so "configured" already means "active".
  const activeWithoutReceipt = vault.configured === true && vault.confirmationRequired === false;
  const state = vault.confirmed === true || activeWithoutReceipt
    ? "ready"
    : vault.configured === true ? "degraded" : "unavailable";
  const summary = vault.confirmed === true
    ? `${targets} configured and confirmed. Mirroring is active.`
    : activeWithoutReceipt
      ? `${targets} configured; path confirmation is switched off, so mirroring is active without a confirm step.`
      : vault.configured === true
        ? `${targets} configured but not yet confirmed. Run the confirm step below.`
        : "No target configured yet. Adopt an existing one or create a new one.";
  const found = Number.isFinite(vault.candidates) && vault.candidates > 0
    ? `${vault.candidates} target${vault.candidates === 1 ? "" : "s"} detected on this machine.`
    : "No target detected on this machine.";
  const rows = asArray(vault.commands).filter((entry) => asObject(entry)).map((entry) => (
    `<tr><th scope="row"><code>${safeText(entry.command)}</code></th><td>${safeText(entry.purpose)}</td></tr>`
  )).join("");
  return `<section class="panel" aria-labelledby="obsidian-title">
<div class="section-heading"><div><h2 id="obsidian-title">Obsidian Target</h2>
<p>${escapeHtml(summary)} ${escapeHtml(found)} Paths are deliberately not shown here &mdash; run the detect command to see them on your own machine. Changing the target happens through the CLI: the confirmation is a one-time, identity-bound step, so a single click on a web page must not be able to bind a target.</p></div>
${renderBadge(state)}</div>
<div class="table-wrap"><table><thead><tr><th scope="col">Command</th><th scope="col">What it does</th></tr></thead><tbody>${rows}</tbody></table></div>
</section>`;
}

function renderCredentials(value) {
  const credentials = asObject(value);
  const rows = CREDENTIAL_UI_DEFINITIONS.map(([key, label, defaultPath, purpose]) => {
    const credential = asObject(credentials[key]);
    const status = stateName(credential.status);
    const rawSource = typeof credential.source === "string" && credential.source ? credential.source : null;
    // A host-routed capability is not missing anything, so it must not wear the
    // "missing" badge: the source becomes the status and the column explains it.
    const source = rawSource === "host_route"
      ? "OpenClaw default route"
      : rawSource === "env_default"
        ? "environment (default variable)"
        : rawSource;
    // Show where the key actually is, not where it could have been: a Cohere
    // key in `reranker.apiKeyEnv` used to be labelled `reranker.apiKey`, which
    // sent the reader to the wrong config line.
    const resolvedPath = typeof credential.path === "string" && credential.path ? credential.path : defaultPath;
    // With the default variable there is no config line to point at; name the
    // variable instead so the reader knows where the key was found.
    const path = rawSource === "env_default" ? `env ${resolvedPath}` : resolvedPath;
    // Purpose and explanations are text, not title attributes: a hover reaches
    // neither the keyboard nor most screen readers.
    return `<tr>`
      + `<th scope="row"><span class="cred-label">${escapeHtml(label)}</span>`
      + `<span class="feature-purpose">${escapeHtml(purpose)}</span>`
      + `<code class="hint">${escapeHtml(path)}</code></th>`
      + `<td>${renderBadge(rawSource === "host_route" ? "host_route" : credential.status)}</td>`
      + `<td>${safeText(source, status === "not_required" ? "no key needed" : "not configured")}</td>`
      + `</tr>`;
  }).join("");
  const statusLegend = Object.entries(CREDENTIAL_STATUS_HELP)
    .map(([name, text]) => `<dt>${escapeHtml(name)}</dt><dd>${escapeHtml(text)}</dd>`).join("");
  const sourceLegend = Object.entries(CREDENTIAL_SOURCE_HELP)
    .map(([name, text]) => `<dt>${escapeHtml(name)}</dt><dd>${escapeHtml(text)}</dd>`).join("");
  return `<section class="panel" aria-labelledby="credentials-title">
<div class="section-heading"><div><h2 id="credentials-title">Credential Readiness</h2>
<p>Readiness only &mdash; values and references are never shown, not even redacted. To change a key, edit the listed config path or manage it under OpenClaw Secrets; this tab is read-only by design.</p></div>
<a class="button-link" href="/secrets">OpenClaw Secrets</a></div>
<div class="table-wrap"><table><thead><tr><th scope="col">Capability</th><th scope="col">Status</th><th scope="col">Source</th></tr></thead><tbody>${rows}</tbody></table></div>
<details class="legend"><summary>What status and source mean</summary>
<dl><dt class="legend-group">Status</dt><dd></dd>${statusLegend}<dt class="legend-group">Source</dt><dd></dd>${sourceLegend}</dl>
</details>
</section>`;
}

function renderEmbeddingDimensionPlanner(values) {
  const profiles = asArray(values).filter((entry) => asObject(entry));
  const cards = profiles.map((profile) => {
    const selected = safeInteger(profile.selectedDimensions);
    const presets = asArray(profile.presets).filter((value) => safeInteger(value) !== null);
    let control;
    if (presets.length === 0) {
      control = "<p><strong>Runtime probe required.</strong> No dimensions are guessed for this model.</p>";
    } else {
      const options = presets.map((dimension) => {
        const isSelected = selected === dimension;
        const suffix = profile.mode === "fixed"
          ? " (fixed)"
          : dimension === profile.defaultDimensions
            ? " (automatic default)"
            : "";
        return `<option value="${dimension}"${isSelected ? " selected" : ""}>${dimension}${suffix}</option>`;
      }).join("");
      control = `<label for="dimension-${safeText(profile.id)}">Verified presets</label><select id="dimension-${safeText(profile.id)}" aria-label="Dimensions for ${safeText(profile.model)}">${options}</select>`;
    }
    const license = profile.commercialUse === false && profile.license
      ? `<p class="model-license"><strong>License:</strong> ${safeText(profile.license)} — local use is non-commercial only.</p>`
      : "";
    const selectionRule = profile.presetOnly === true ? " Only the listed dimensions are valid." : "";
    return `<article class="card"><div class="card-heading"><h3>${safeText(profile.model)}</h3>${renderBadge(profile.current === true ? "current" : profile.mode)}</div><p><code>${safeText(profile.provider)}</code></p>${control}<p>Allowed range: ${profile.minDimensions === null ? "probe result" : `${safeText(profile.minDimensions)}–${safeText(profile.maxDimensions)}`}.${selectionRule} Every migration still validates a real returned vector.</p>${license}</article>`;
  }).join("");
  return `<section class="panel" aria-labelledby="embedding-dimension-planner-title"><div class="section-heading"><div><h2 id="embedding-dimension-planner-title">Embedding Dimension Planner</h2><p>Model-dependent choices for re-embedding. JinaAI v3 is an embedding model; the separate JinaAI and BGE rerankers do not define memory-vector dimensions.</p></div></div><div class="grid grid-3">${cards || "<p class=\"empty\">No verified dimension profiles are available.</p>"}</div><div class="notice"><strong>Read-only planning controls.</strong> Apply a target only through the confirmed operator-admin re-embedding action. A reload restores the persisted active or migration state.</div></section>`;
}

const EMBEDDING_PROFILE_CHOICES = Object.freeze([
  Object.freeze({ id: "e5-multilingual-384", label: "E5 multilingual, 384 dimensions", detail: "Small, fast, commercially usable." }),
  Object.freeze({ id: "jina-v3-multilingual-512", label: "JinaAI v3 multilingual, 512 dimensions", detail: "Stronger multilingual recall. Non-commercial license, must be acknowledged." }),
  Object.freeze({ id: "jina-v3-multilingual-1024", label: "JinaAI v3 multilingual, 1024 dimensions", detail: "Highest quality of the local set, largest vectors. Non-commercial license." }),
  Object.freeze({ id: "jina-v5-nano-512", label: "JinaAI v5 Text Nano, 512 dimensions", detail: "New option, lab test pending. 239M parameters, 15 European languages, fastest local model. Non-commercial license." }),
  Object.freeze({ id: "jina-v5-nano-768", label: "JinaAI v5 Text Nano, 768 dimensions", detail: "New option, lab test pending. Full width of the nano model. Non-commercial license." }),
]);

function renderEmbeddingProfileSwitch(write, preparation) {
  if (!write.embedding) return "";
  const active = asObject(preparation).profileId;
  const options = EMBEDDING_PROFILE_CHOICES.map((choice) => {
    const label = `<span class="switch-label">${escapeHtml(choice.label)}</span><span class="switch-detail">${escapeHtml(choice.detail)}</span>`;
    if (choice.id === active) return `<li class="switch-option is-current">${label}${renderBadge("current")}</li>`;
    const license = choice.id.startsWith("jina-")
      ? `<input type="hidden" name="accept_license" value="yes">`
      : "";
    return `<li class="switch-option">${label}`
      + `${formStart(write, "embedding.profile")}`
      + `<input type="hidden" name="profile" value="${escapeHtml(choice.id)}">${license}`
      + `<button type="submit">Prepare</button></form></li>`;
  }).join("");
  return `<div class="notice"><strong>Choosing a target only prepares it.</strong> The download is verified against pinned hashes, and nothing in your memory changes until the migration below is run. Selecting a JinaAI target records the non-commercial license acknowledgement.</div>
<ul class="switch-list">${options}</ul>`;
}

function renderModelPreparation(value, write = writeContext(null)) {
  const preparation = asObject(value);
  if (!preparation.state) {
    return `<section class="panel" aria-labelledby="model-preparation-title"><div class="section-heading"><div><h2 id="model-preparation-title">Model Preparation</h2><p>Select a pinned model/dimension profile in OpenClaw Config to download and validate it without changing the active vector space.</p></div>${renderBadge("not_configured")}</div><div class="notice"><strong>Safe default:</strong> no model is downloaded until a preparation profile is selected. <a href="/config">Choose a profile in OpenClaw Config</a>.</div>${renderEmbeddingProfileSwitch(write, preparation)}</section>`;
  }
  const bytesCompleted = safeInteger(preparation.bytesCompleted, 0);
  const bytesTotal = safeInteger(preparation.bytesTotal, 0);
  const displayedBytes = Math.min(bytesCompleted, bytesTotal);
  const artifactsCompleted = safeInteger(preparation.artifactsCompleted, 0);
  const artifactsTotal = safeInteger(preparation.artifactsTotal, 0);
  const progress = bytesTotal > 0
    ? `<div class="migration-progress"><div class="progress-heading"><strong>Verified download</strong><span>${formatBytes(displayedBytes)} of ${formatBytes(bytesTotal)}</span></div><progress aria-label="Local model download progress" value="${displayedBytes}" max="${bytesTotal}">${Math.floor((displayedBytes * 100) / bytesTotal)}%</progress><p>${artifactsCompleted} of ${artifactsTotal} immutable artifacts verified.</p></div>`
    : "";
  const licenseAcknowledgementRequired = preparation.errorCode
    === "non_commercial_license_acknowledgement_required";
  const licenseAcknowledged = ["downloading", "validating", "ready"].includes(preparation.state);
  const license = preparation.commercialUse === false
    ? licenseAcknowledgementRequired
      ? `<div class="notice"><strong>License acknowledgement required:</strong> ${safeText(preparation.license)} permits non-commercial use only. OpenClaw Config must record the explicit acknowledgement before download.</div>`
      : licenseAcknowledged
        ? `<div class="notice"><strong>Non-commercial license acknowledged:</strong> ${safeText(preparation.license)} applies to this prepared model.</div>`
        : `<div class="notice"><strong>Non-commercial model:</strong> ${safeText(preparation.license)} permits non-commercial use only. Download requires explicit acknowledgement in OpenClaw Config.</div>`
    : "";
  const suggestion = asObject(preparation.reembedding);
  let recommendation = "";
  if (suggestion.status === "recommended") {
    recommendation = `<div class="notice"><strong>Re-embedding dry-run recommendation:</strong> ${safeInteger(suggestion.rows, 0)} cards would require approximately ${formatBytes(suggestion.targetBytes)} in the isolated target generation. This recommendation does not start copying or switch the active model. Start the typed plan action only after review; application and ready-to-switch remain separately confirmed.</div>`;
  } else if (suggestion.status === "blocked_insufficient_disk") {
    recommendation = `<div class="notice"><strong>Re-embedding dry-run blocked:</strong> ${formatBytes(suggestion.requiredFreeBytes)} free space is required; ${formatBytes(suggestion.freeBytes)} is available. The active model remains unchanged.</div>`;
  } else if (suggestion.status === "empty_source") {
    recommendation = `<div class="notice"><strong>Empty memory generation:</strong> no cards require copying. A direct initialization is suggested but still requires an explicit operator confirmation.</div>`;
  } else if (suggestion.status === "not_required") {
    recommendation = `<div class="notice"><strong>No re-embedding required:</strong> the verified target fingerprint already matches the active embedding generation.</div>`;
  }
  const failure = preparation.errorCode
    ? `<div class="notice"><strong>Preparation diagnostic:</strong> <code>${safeText(preparation.errorCode)}</code>. The active model and existing memories were not changed.</div>`
    : "";
  return `<section class="panel" aria-labelledby="model-preparation-title">
<div class="section-heading"><div><h2 id="model-preparation-title">Model Preparation</h2><p>The selected local model is downloaded and hash-validated automatically. Model preparation cannot mutate LanceDB or activate a different dimension.</p></div>${renderBadge(preparation.state)}</div>
<dl><dt>Profile</dt><dd><code>${safeText(preparation.profileId)}</code></dd><dt>Model</dt><dd>${safeText(preparation.model)}</dd><dt>Revision</dt><dd><code>${safeText(preparation.revision)}</code></dd><dt>Dimensions</dt><dd>${safeText(preparation.dimensions)}</dd><dt>Target fingerprint</dt><dd><code>${safeText(preparation.targetFingerprintId, "pending validation")}</code></dd></dl>
${progress}${license}${failure}${recommendation}${renderEmbeddingProfileSwitch(write, preparation)}
<p><a href="/config">Change the preparation profile</a>. A changed profile restarts only this resumable preparation stage.</p>
</section>`;
}

function renderMigrationProgress(migration) {
  const processed = safeInteger(migration.processed);
  const total = safeInteger(migration.total);
  if (processed === null || total === null || total === 0) return "";
  const displayProcessed = Math.min(processed, total);
  const percent = Math.floor((displayProcessed * 100) / total);
  return `<div class="migration-progress"><div class="progress-heading"><strong>Checkpoint progress</strong><span>${percent}%</span></div><progress aria-label="Re-embedding checkpoint progress" value="${displayProcessed}" max="${total}">${percent}%</progress><p>${displayProcessed} of ${total} cards copied into the isolated target generation.</p></div>`;
}

function renderReembeddingSwitch(write, workflow, preparation) {
  if (!write.embedding) return "";
  const migration = asObject(asObject(workflow).migration);
  const prep = asObject(preparation);
  const state = stateName(migration.state);
  const ready = prep.state === "ready" && typeof prep.targetFingerprintId === "string" && prep.targetFingerprintId;
  const step = (action, label, note) => `${formStart(write, action)}`
    + `<input type="hidden" name="migration" value="${escapeHtml(migration.id || "")}">`
    + `<button type="submit">${escapeHtml(label)}</button></form><p class="hint">${escapeHtml(note)}</p>`;
  if (!migration.id || ["completed", "failed", "rolled_back"].includes(state)) {
    if (!ready) {
      return `<p class="hint">A dry run needs a prepared and verified target. Choose one under Model Preparation first.</p>`;
    }
    return `<div class="switch-actions">${step("reembedding.plan", "Start dry run", "Counts the cards, estimates the space, and validates the target. Copies nothing and switches nothing.")}</div>`;
  }
  if (state === "planned") {
    return `<div class="switch-actions">${step("reembedding.apply", "Start the copy", "Copies every card into an isolated target generation, with checkpoints. The active model stays untouched until you switch.")}</div>`;
  }
  if (["validating", "ready_to_switch"].includes(state)) {
    return `<div class="switch-actions">${step("reembedding.switch", "Switch the active model", "Points recall at the new generation. The old generation is kept for rollback.")}</div>`;
  }
  if (state === "running") {
    return `<p class="hint">The copy is running. This page refreshes itself while it does.</p>`;
  }
  return `<p class="hint">No action is offered for the state <code>${escapeHtml(state)}</code>. Use the CLI for rollback and repair.</p>`;
}

function renderReembeddingWorkflow(value, write = writeContext(null), preparation = null) {
  const workflow = asObject(value);
  const migration = asObject(workflow.migration);
  const refreshSeconds = activeReembeddingRefreshSeconds(workflow);
  const steps = asArray(workflow.steps)
    .filter((entry) => asObject(entry))
    .map((entry) => `<li class="workflow-step"><span>${safeText(entry.label)}</span>${renderBadge(entry.state)}</li>`)
    .join("");
  const migrationDetails = migration.id
    ? `<dl class="migration-details"><dt>Migration</dt><dd><code>${safeText(migration.id)}</code></dd><dt>State</dt><dd>${renderBadge(migration.state)}</dd><dt>Progress</dt><dd>${safeInteger(migration.processed, 0)} / ${safeInteger(migration.total, 0)} cards</dd><dt>Target dimensions</dt><dd>${safeText(migration.targetDimensions)}</dd><dt>Target fingerprint</dt><dd><code>${safeText(migration.targetFingerprint)}</code></dd><dt>Estimate</dt><dd>${formatBytes(migration.estimatedBytes)}</dd><dt>Checkpoint bytes</dt><dd>${formatBytes(migration.checkpointBytes)}</dd></dl>`
    : "<p class=\"empty\">No active re-embedding migration.</p>";
  return `<section class="panel" aria-labelledby="reembedding-workflow-title">
<div class="section-heading"><div><h2 id="reembedding-workflow-title">Re-Embedding Workflow</h2><p>Dry run, estimate, target validation, checkpointed copy, controlled switch, and rollback planning.</p></div>${renderBadge(workflow.mutationSurface)}</div>
<div class="notice"><strong>No silent dimension change.</strong> A target fingerprint must pass the confirmed operator-admin workflow before a runtime switch.</div>
<ol class="workflow">${steps || "<li class=\"workflow-step\">Workflow status is not available.</li>"}</ol>${migrationDetails}${renderMigrationProgress(migration)}${refreshSeconds ? `<p class="refresh-status" role="status">Auto-refresh is active while the migration runs (every ${refreshSeconds} seconds). <a href="${CONTROL_UI_PATH}">Refresh now</a>.</p>` : ""}
${renderReembeddingSwitch(write, workflow, preparation)}
<p>${write.embedding
      ? "The confirmation token that binds each step stays inside the Gateway; your second click is the confirmation. Rollback and repair remain CLI-only."
      : "Use the authenticated PLUR1BUS re-embedding Gateway/session action or CLI for mutations; this tab remains read-only."}</p>
</section>`;
}

function renderProjection(projection, nowMs = Date.now(), rawWrite = null) {
  const status = asObject(projection);
  const write = writeContext(rawWrite);
  const refreshSeconds = dashboardRefreshSeconds(status);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${refreshSeconds ? `<meta http-equiv="refresh" content="${refreshSeconds}">` : ""}
<title>PLUR1BUS operator dashboard</title>
<style>
/* The tab is an iframe with an opaque origin: it cannot read the host's
   stylesheet and receives no theme message. The Control UI tokens are copied
   here under their own names, dark first like the host, light on the OS
   setting, which is what the host's default "system" mode follows too. */
:root {
  color-scheme: dark;
  --bg: #0e1015; --panel: #0e1015; --panel-strong: #191c24; --card: #161920; --bg-elevated: #191c24;
  --text: #bcbcc0; --text-strong: #f4f4f5; --muted: #8b8b94;
  --accent: #ff5c5c; --accent-hover: #ff7070; --accent-subtle: #ff5c5c1a;
  --border: #1e2028; --border-strong: #2e3040;
  --ok: #22c55e; --warn: #f59e0b; --danger: #f87171; --info: #60a5fa;
  --radius: 10px; --radius-sm: 6px; --radius-full: 9999px;
  --shadow-sm: 0 1px 2px #00000040;
  --font-body: "Instrument Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, monospace;
}
@media (prefers-color-scheme: light) {
  :root {
    color-scheme: light;
    --bg: #faf9f7; --panel: #faf9f7; --panel-strong: #f4f1ec; --card: #fff; --bg-elevated: #fff;
    --text: #403c35; --text-strong: #211e1a; --muted: #6e6960;
    --accent: #bd4531; --accent-hover: #a83c29; --accent-subtle: #bd453114;
    --border: #e8e4dc; --border-strong: #d6d0c5;
    --ok: #166534; --warn: #92400e; --danger: #b91c1c; --info: #1d4ed8;
    --shadow-sm: 0 1px 2px #3c2a180d;
  }
}
* { box-sizing: border-box; }
body { margin: 0; padding: 18px 20px 32px; background: var(--bg); color: var(--text); font: 400 14px/1.55 var(--font-body); letter-spacing: -.01em; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
main { max-width: 1180px; margin: auto; }
h1 { margin: 0; color: var(--accent); font-size: 22px; font-weight: 650; letter-spacing: -.03em; line-height: 1.2; }
h2 { margin: 0; color: var(--text-strong); font-size: 15px; font-weight: 600; letter-spacing: -.02em; }
h3 { margin: 0 0 8px; color: var(--text-strong); font-size: 13px; font-weight: 600; letter-spacing: -.01em; }
p { margin: 6px 0; color: var(--muted); font-size: 13px; line-height: 1.5; }
a { color: var(--accent); text-decoration: none; } a:hover { color: var(--accent-hover); text-decoration: underline; }
code { font-family: var(--font-mono); font-size: .92em; padding: 1px 5px; border-radius: var(--radius-sm); background: color-mix(in srgb, var(--text) 9%, transparent); color: var(--text-strong); overflow-wrap: anywhere; }
strong { color: var(--text-strong); font-weight: 600; }
.hero, .section-heading, .card-heading { display: flex; gap: 12px; align-items: flex-start; justify-content: space-between; }
.hero { margin-bottom: 14px; } .hero p { margin-top: 4px; }
.panel { margin: 14px 0; padding: 14px 16px; background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); }
.card { padding: 12px; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow-sm); }
.notice { margin-top: 12px; padding: 10px 12px; background: var(--panel-strong); border: 1px solid var(--border); border-radius: var(--radius); font-size: 13px; }
.notice ul { margin: 6px 0 0 18px; padding: 0; }
.grid { display: grid; gap: 12px; margin-top: 12px; } .grid-2 { grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr)); } .grid-3 { grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); }
.badge { display: inline-flex; align-items: center; gap: 5px; padding: 3px 10px; border: 1px solid var(--border); border-radius: var(--radius-full); background: var(--panel-strong); color: var(--text); font-size: 12px; font-weight: 500; white-space: nowrap; }
/* The wording on the badge carries the meaning; colour only echoes it. */
.badge-ready, .badge-enabled, .badge-complete, .badge-configured { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 45%, transparent); background: color-mix(in srgb, var(--ok) 12%, transparent); }
.badge-degraded, .badge-current, .badge-attention, .badge-missing { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, transparent); background: color-mix(in srgb, var(--warn) 12%, transparent); }
.badge-failed, .badge-disabled, .badge-unavailable { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 45%, transparent); background: color-mix(in srgb, var(--danger) 12%, transparent); }
.badge-not_required, .badge-optional { color: var(--muted); }
.badge-host_route { color: var(--info); border-color: color-mix(in srgb, var(--info) 45%, transparent); background: color-mix(in srgb, var(--info) 12%, transparent); }
dl { display: grid; grid-template-columns: minmax(7rem, auto) 1fr; gap: 4px 12px; margin: 0; font-size: 13px; } dt { color: var(--muted); } dd { margin: 0; min-width: 0; color: var(--text); }
.count-list { list-style: none; margin: 0; padding: 0; font-size: 13px; } .count-list li { display: flex; justify-content: space-between; gap: 12px; padding: 3px 0; border-bottom: 1px solid var(--border); } .count-list li:last-child { border-bottom: 0; }
.table-wrap { overflow-x: auto; } table { border-collapse: collapse; width: 100%; margin-top: 10px; font-size: 13px; }
th, td { padding: 8px 10px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
thead th { color: var(--muted); font-size: 12px; font-weight: 500; letter-spacing: .04em; text-transform: uppercase; }
tbody tr:hover td, tbody tr:hover th { background: color-mix(in srgb, var(--text) 4%, transparent); }
th[scope="row"] { font-weight: 600; color: var(--text-strong); }
.workflow { list-style: none; padding: 0; margin: 12px 0; display: grid; gap: 6px; }
.workflow-step { display: flex; justify-content: space-between; gap: 12px; padding: 8px 10px; border-left: 3px solid var(--border-strong); background: var(--card); border-radius: var(--radius-sm); }
.migration-progress { margin-top: 12px; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--card); }
.progress-heading { display: flex; justify-content: space-between; gap: 12px; }
progress { width: 100%; height: 10px; margin-top: 8px; accent-color: var(--accent); }
.refresh-status { margin-top: 12px; }
.card-list { list-style: none; padding: 0; }
.feature-card { display: flex; flex-direction: column; gap: 4px; }
.feature-purpose { margin: 0; color: var(--text); }
.feature-note { margin: 0; font-size: 12.5px; } .feature-note .label { color: var(--muted); }
.summary { font-variant-numeric: tabular-nums; color: var(--text-strong); font-weight: 600; }
.hint { font-size: 12px; color: var(--muted); }
.cred-label { display: block; }
th[scope="row"] .feature-purpose { display: block; font-weight: 400; color: var(--muted); max-width: 34rem; }
th[scope="row"] .hint { display: block; }
.legend { margin-top: 14px; font-size: 13px; }
.legend summary { cursor: pointer; font-weight: 600; color: var(--text-strong); padding: 4px 0; }
.legend dl { margin-top: 8px; grid-template-columns: minmax(6rem, auto) 1fr; }
.legend .legend-group { grid-column: 1 / -1; margin-top: 8px; color: var(--text-strong); font-weight: 600; }
.empty { font-style: italic; } .button-link { white-space: nowrap; }
.card-wide { grid-column: 1 / -1; }
.switch-list { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 6px; }
.switch-option { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--panel-strong); }
.switch-option.is-current { border-color: color-mix(in srgb, var(--ok) 45%, transparent); }
.switch-label { display: block; color: var(--text-strong); font-weight: 600; font-size: 13px; }
.switch-detail { display: block; color: var(--muted); font-size: 12px; }
.switch-form { margin: 0; }
.row-form { display: inline-flex; align-items: center; margin: 0; }
.row-form button { padding: 2px 8px; font-size: 12px; font-weight: 500; }
.row-tail { display: inline-flex; align-items: center; gap: 10px; }
.row-note { font-size: 12px; color: var(--muted); white-space: nowrap; }
.switch-actions { margin-top: 12px; display: grid; gap: 6px; }
button { font: inherit; font-weight: 600; padding: 6px 14px; border: 1px solid var(--border-strong); border-radius: var(--radius-sm); background: var(--accent); color: #fff; cursor: pointer; white-space: nowrap; }
button:hover { background: var(--accent-hover); }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.notice-result { border-color: color-mix(in srgb, var(--accent) 45%, transparent); }
a:focus-visible, [tabindex]:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: var(--radius-sm); }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
</style>
</head>
<body>
<main>
<header class="hero"><div><h1>PLUR1BUS</h1><p>Operator dashboard for isolated, long-term memory.</p></div>${renderBadge(status.schemaVersion === 2 ? "ready" : "unavailable")}</header>
${renderResultBanner(write)}
<section class="notice">${write.mode === "off"
      ? "<strong>Read-only control tab.</strong> The published OpenClaw tab grants only read scope. Use <a href=\"/config\">OpenClaw Config</a>, <a href=\"/secrets\">OpenClaw Secrets</a>, and the typed authenticated PLUR1BUS actions for changes."
      : `<strong>Switching is enabled on this tab.</strong> <code>controlUi.writeActions</code> is set to <code>${escapeHtml(write.mode)}</code>, so this page can change the running configuration. Everything else stays read-only, and secrets are still managed under <a href="/secrets">OpenClaw Secrets</a>.`}</section>
${renderMemoryHealth(status.memoryHealth, status.providers, status.features, nowMs, write)}
${renderWorkspaceMatrix(status.workspaceMatrix)}
${renderFeatureControls(status.featureCards)}
${renderObsidianVault(status.obsidianVault)}
${renderCredentials(status.credentials)}
${renderEmbeddingDimensionPlanner(status.embeddingDimensionProfiles)}
${renderModelPreparation(status.modelPreparation, write)}
${renderReembeddingWorkflow(status.reembeddingWorkflow, write, status.modelPreparation)}
</main>
${renderSubmitScript(write)}</body>
</html>`;
}

// The host's plugin tab is an iframe sandboxed with allow-scripts only. The
// browser refuses a native form submission there ("the 'allow-forms'
// permission is not set"), so every switch on this page would silently do
// nothing. This script posts the form with fetch instead: same fields plus
// `via=fetch`, cookie included, response ignored (no-cors), then the page
// navigates itself to show the stored result. The single-use token still
// guards the request. Read-only pages carry no script at all.
function renderSubmitScript(write) {
  if (write.mode === "off" || !write.nonce) return "";
  // In a sandboxed frame the browser refuses the submission BEFORE it fires
  // the submit event (HTML form submission algorithm), so a submit listener
  // never runs there. The click on the submit button is what gets intercepted.
  // The host authenticates a sandboxed frame's fetch only as GET with the tab
  // cookie (a POST from the opaque origin is answered 401), so the action
  // travels in the query string. The single-use token still guards it.
  return `<script nonce="${escapeHtml(write.nonce)}">(function () {
  function send(form) {
    var query = new URLSearchParams(new FormData(form));
    query.set("via", "fetch");
    Array.prototype.forEach.call(form.querySelectorAll("button"), function (button) { button.disabled = true; });
    fetch(form.getAttribute("action") + "?" + query.toString(), { method: "GET", mode: "no-cors", credentials: "include" })
      .catch(function () {})
      .then(function () { window.location.replace(${JSON.stringify(CONTROL_UI_PATH)}); });
  }
  var forms = document.querySelectorAll('form[method="post"]');
  Array.prototype.forEach.call(forms, function (form) {
    Array.prototype.forEach.call(form.querySelectorAll('button[type="submit"]'), function (button) {
      button.addEventListener("click", function (event) {
        event.preventDefault();
        if (!button.disabled) send(form);
      });
    });
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      send(form);
    });
  });
})();</script>
`;
}

// connect-src for the fetch submit. The sandboxed frame has an opaque origin,
// so 'self' would match nothing; the page names the host it was served from,
// over either scheme, and nothing else. An unusable Host header yields no
// connect-src at all, which leaves the native form path as the only one.
function connectSourcesFor(request) {
  const host = request?.headers?.host;
  if (typeof host !== "string" || !/^[A-Za-z0-9.\-]+(?::\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](?::\d{1,5})?$/.test(host)) return "";
  return `http://${host} https://${host}`;
}

function queryOf(url) {
  const query = String(url || "").split("?")[1];
  return new URLSearchParams(query && query.length <= 4096 ? query : "");
}

function resultFromUrl(url) {
  const value = queryOf(url).get("result");
  return typeof value === "string" && /^[a-z_]{1,40}$/.test(value) ? value : "";
}

/**
 * Create the status page handler.
 *
 * Without a write surface this stays exactly what it was: GET and HEAD only.
 * With one, POST applies a single action and answers with a redirect, so a
 * reload never repeats it.
 */
export function createControlUiHttpHandler({ getProjection, now = Date.now, write = null } = {}) {
  if (typeof getProjection !== "function") throw new Error("PLUR1BUS control projection is required");
  if (typeof now !== "function") throw new Error("PLUR1BUS control clock is required");
  const mode = write?.mode === "reranker" || write?.mode === "all" ? write.mode : "off";
  const writable = mode !== "off";
  if (writable && (typeof write?.tokens?.issue !== "function" || typeof write?.applyAction !== "function")) {
    throw new Error("PLUR1BUS control write surface is incomplete");
  }

  // A fetch-submitted action cannot read the redirect (opaque response), so
  // its result waits here for the page's next load. One operator per tab;
  // the entry is shown once and expires quickly.
  let pendingResult = null;
  const PENDING_RESULT_TTL_MS = 90_000;
  const takePendingResult = () => {
    if (!pendingResult) return "";
    const { code, at } = pendingResult;
    pendingResult = null;
    return now() - at <= PENDING_RESULT_TTL_MS ? code : "";
  };

  const renderPage = async (request, response, result) => {
    const projection = await getProjection({ surface: "http" });
    // base64url: no "+" or "/" that would need escaping inside the attribute or the CSP.
    const nonce = writable ? randomBytes(18).toString("base64url") : "";
    const body = renderProjection(projection, now(), writable
      ? {
          mode,
          token: write.tokens.issue(),
          result: result || takePendingResult(),
          keyConfigured: write.rerankerKeyConfigured?.() === true,
          compaction: typeof write.compactionStatus === "function" ? write.compactionStatus() : null,
          nonce,
        }
      : null);
    response.statusCode = 200;
    setHeaders(response, "text/html; charset=utf-8", {
      allowForms: writable,
      nonce,
      connectSrc: writable ? connectSourcesFor(request) : "",
    });
    response.end(request.method === "HEAD" ? "" : body);
  };

  // One action: consume the token, apply, answer. A fetch-submitted action
  // gets 204 and its result is parked for the next page load; a native form
  // gets the redirect. The tab cookie is SameSite=None, so a valid single-use
  // token from a page this operator loaded is what separates a click from a
  // cross-site request, whichever method carried it.
  const applyForm = async (form, response) => {
    const code = write.tokens.consume(form.get(CONTROL_UI_FORM_TOKEN_FIELD))
      ? (await write.applyAction({ action: form.get(CONTROL_UI_ACTION_FIELD), form, mode })).code
      : "denied_token";
    if (form.get("via") === "fetch") {
      pendingResult = { code, at: now() };
      response.statusCode = 204;
      setHeaders(response, "text/plain; charset=utf-8", { allowForms: true });
      response.end("");
      return;
    }
    response.statusCode = 303;
    response.setHeader("location", `${CONTROL_UI_PATH}?result=${encodeURIComponent(code)}`);
    setHeaders(response, "text/plain; charset=utf-8", { allowForms: true });
    response.end("");
  };

  return async (request, response) => {
    const method = request?.method;
    if (method === "POST" && writable) {
      try {
        await applyForm(await readFormBody(request), response);
      } catch {
        response.statusCode = 400;
        setHeaders(response, "text/plain; charset=utf-8", { allowForms: true });
        response.end("Invalid PLUR1BUS control request");
      }
      return true;
    }
    if (method !== "GET" && method !== "HEAD") {
      response.statusCode = 405;
      response.setHeader("allow", writable ? "GET, HEAD, POST" : "GET, HEAD");
      setHeaders(response, "text/plain; charset=utf-8", { allowForms: writable });
      response.end("Method not allowed");
      return true;
    }
    // An action carried by GET: only from a writable page, only with the
    // token and an action name, only as the script sends it (via=fetch). The
    // host refuses a POST from the sandboxed frame, so this is the path the
    // buttons actually take inside the plugin tab.
    if (method === "GET" && writable) {
      const query = queryOf(request?.url);
      if (query.get("via") === "fetch" && query.get(CONTROL_UI_ACTION_FIELD) && query.get(CONTROL_UI_FORM_TOKEN_FIELD)) {
        try {
          await applyForm(query, response);
        } catch {
          response.statusCode = 400;
          setHeaders(response, "text/plain; charset=utf-8", { allowForms: true });
          response.end("Invalid PLUR1BUS control request");
        }
        return true;
      }
    }
    try {
      await renderPage(request, response, resultFromUrl(request?.url));
    } catch {
      response.statusCode = 503;
      setHeaders(response, "text/plain; charset=utf-8", { allowForms: writable });
      response.end(request.method === "HEAD" ? "" : "PLUR1BUS status is temporarily unavailable");
    }
    return true;
  };
}

function validateStatusParams(params) {
  if (params === undefined) return;
  if (!params || typeof params !== "object" || Array.isArray(params) || Object.keys(params).length !== 0) {
    throw new Error("invalid PLUR1BUS control status request");
  }
}

/** Register OpenClaw read surfaces with capability detection and no write bridge. */
export function registerControlUiRuntime({ api, getProjection, write = null } = {}) {
  if (typeof api?.registerGatewayMethod !== "function") {
    throw new Error("OpenClaw registerGatewayMethod capability unavailable for PLUR1BUS control status");
  }
  if (typeof getProjection !== "function") throw new Error("PLUR1BUS control projection is required");

  api.registerGatewayMethod(
    CONTROL_UI_GATEWAY_METHOD,
    async ({ params, respond }) => {
      try {
        validateStatusParams(params);
        respond(true, { status: await getProjection({ surface: "gateway" }) });
      } catch {
        respond(false, undefined, {
          code: "plur1bus_control_status_unavailable",
          message: "PLUR1BUS control status is unavailable",
        });
      }
    },
    { scope: "operator.read" },
  );

  // OpenClaw exposes this both flat on the api object and, since the facade
  // rework, under session.controls. Reading only the nested path silently
  // registered no tab on 2026.8.2 — the HTTP route answered, but the Control UI
  // reported "Plugin panel unavailable" because no descriptor ever arrived.
  const registerDescriptor = typeof api.registerControlUiDescriptor === "function"
    ? api.registerControlUiDescriptor.bind(api)
    : api.session?.controls?.registerControlUiDescriptor;
  if (typeof api.registerHttpRoute !== "function" || typeof registerDescriptor !== "function") {
    api.logger?.warn?.("memory-lancedb-namespaced: OpenClaw Control UI tab capability unavailable; Gateway status remains active");
    return { tabRegistered: false };
  }

  const mode = write?.mode === "reranker" || write?.mode === "all" ? write.mode : "off";
  api.registerHttpRoute({
    path: CONTROL_UI_PATH,
    auth: "gateway",
    match: "exact",
    handler: createControlUiHttpHandler({ getProjection, write }),
  });
  // The host mints the frame's grant from these scopes and only mounts the tab
  // for an operator who holds them. Asking for write authority while the tab
  // cannot use it would hide the dashboard from read-only operators for
  // nothing, so the scope follows the configured mode.
  registerDescriptor({
    surface: "tab",
    id: "plur1bus",
    label: "PLUR1BUS",
    description: mode === "off"
      ? "Workspace memory, providers, and migration status"
      : "Workspace memory, providers, migration status, and provider switching",
    path: CONTROL_UI_PATH,
    icon: "database",
    group: "control",
    requiredScopes: mode === "off" ? ["operator.read"] : ["operator.read", "operator.write"],
  });
  return { tabRegistered: true, writeMode: mode };
}
