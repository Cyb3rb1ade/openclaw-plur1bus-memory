export const CONTROL_UI_GATEWAY_METHOD = "plur1bus.control.status";
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

function setHeaders(response, contentType = "text/html; charset=utf-8") {
  response.setHeader("cache-control", "no-store, max-age=0");
  response.setHeader("content-type", contentType);
  response.setHeader(
    "content-security-policy",
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
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

function renderBadge(value) {
  const state = stateName(value);
  return `<span class="badge badge-${escapeHtml(state)}">${escapeHtml(state.replaceAll("_", " "))}</span>`;
}

function renderCountList(values, emptyMessage) {
  const entries = asArray(values)
    .filter((entry) => asObject(entry) && safeInteger(entry?.cards) !== null)
    .map((entry) => `<li><code>${safeText(entry.id)}</code><strong>${safeInteger(entry.cards)}</strong></li>`);
  return entries.length > 0 ? `<ul class="count-list">${entries.join("")}</ul>` : `<p class="empty">${escapeHtml(emptyMessage)}</p>`;
}

function renderMemoryHealth(value, providers) {
  const health = asObject(value);
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
<div class="section-heading"><div><h2 id="memory-health-title">Memory Health</h2><p>Aggregate-only LanceDB status; no memory card content is shown.</p></div>${renderBadge(health.status)}</div>
<div class="grid grid-3">
<article class="card"><h3>Embedding space</h3><dl><dt>Provider</dt><dd>${safeText(embedding.provider)}</dd><dt>Model</dt><dd>${safeText(embedding.model)}</dd><dt>Fingerprint</dt><dd><code>${safeText(embedding.fingerprint)}</code></dd><dt>Dimensions</dt><dd>${safeText(embedding.dimensions)}</dd></dl></article>
<article class="card"><h3>LanceDB</h3><dl><dt>Storage</dt><dd>${formatBytes(health.storage?.bytes)}</dd><dt>Scan complete</dt><dd>${health.storage?.complete === true ? "yes" : "no"}</dd><dt>Last health error</dt><dd>${error}</dd></dl></article>
<article class="card"><h3>Cards by agent</h3>${renderCountList(cards.byAgent, "No private agent cards observed.")}</article>
</div>
<div class="grid grid-2"><article class="card"><h3>Cards by workspace</h3>${renderCountList(cards.byWorkspace, "No shared workspace cards observed.")}</article><article class="card"><h3>Cards by user</h3>${renderCountList(cards.byUser, "No shared user cards observed.")}</article></div>
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
  const cards = asArray(values)
    .filter((entry) => asObject(entry))
    .map((entry) => {
      const dependencies = asArray(entry.dependencies).map((dependency) => `<code>${safeText(dependency)}</code>`).join(" ") || "none";
      const state = entry.effective === true ? "enabled" : entry.configured === true ? "degraded" : "disabled";
      return `<article class="card feature-card"><div class="card-heading"><h3>${safeText(entry.label)}</h3>${renderBadge(state)}</div><dl><dt>Configured</dt><dd>${entry.configured === true ? "yes" : "no"}</dd><dt>Dependencies</dt><dd>${dependencies}</dd><dt>Reason</dt><dd><code>${safeText(entry.reason, "none")}</code></dd><dt>Audit</dt><dd><code>${safeText(entry.audit, "openclaw_config_audit")}</code></dd></dl><p><a href="/config">Configure</a> · <a href="/secrets">Credentials</a></p></article>`;
    })
    .join("");
  return `<section class="panel" aria-labelledby="feature-controls-title">
<div class="section-heading"><div><h2 id="feature-controls-title">Feature Controls</h2><p>Feature state, dependencies, and the safe OpenClaw configuration surfaces.</p></div></div>
<div class="grid grid-3">${cards || "<p class=\"empty\">Feature cards are not available.</p>"}</div>
</section>`;
}

function renderCredentials(value) {
  const credentials = asObject(value);
  const definitions = [
    ["embedding", "Embedding"],
    ["embeddingFallback", "Embedding fallback"],
    ["reranker", "Reranker"],
    ["skillMiner", "Skill Miner"],
  ];
  const rows = definitions.map(([key, label]) => {
    const credential = asObject(credentials[key]);
    return `<tr><td>${label}</td><td>${renderBadge(credential.status)}</td><td>${safeText(credential.source, "not configured")}</td></tr>`;
  }).join("");
  return `<section class="panel" aria-labelledby="credentials-title"><div class="section-heading"><div><h2 id="credentials-title">Credential Readiness</h2><p>Only readiness is displayed. Values and references are never shown.</p></div><a class="button-link" href="/secrets">OpenClaw Secrets</a></div><div class="table-wrap"><table><thead><tr><th scope="col">Capability</th><th scope="col">Status</th><th scope="col">Source type</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
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

function renderModelPreparation(value) {
  const preparation = asObject(value);
  if (!preparation.state) {
    return `<section class="panel" aria-labelledby="model-preparation-title"><div class="section-heading"><div><h2 id="model-preparation-title">Model Preparation</h2><p>Select a pinned model/dimension profile in OpenClaw Config to download and validate it without changing the active vector space.</p></div>${renderBadge("not_configured")}</div><div class="notice"><strong>Safe default:</strong> no model is downloaded until a preparation profile is selected. <a href="/config">Choose a profile in OpenClaw Config</a>.</div></section>`;
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
${progress}${license}${failure}${recommendation}
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

function renderReembeddingWorkflow(value) {
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
<p>Use the authenticated PLUR1BUS re-embedding Gateway/session action or CLI for mutations; this tab remains read-only.</p>
</section>`;
}

function renderProjection(projection) {
  const status = asObject(projection);
  const refreshSeconds = dashboardRefreshSeconds(status);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${refreshSeconds ? `<meta http-equiv="refresh" content="${refreshSeconds}">` : ""}
<title>PLUR1BUS operator dashboard</title>
<style>
:root { color-scheme: light dark; font: 14px/1.5 system-ui, sans-serif; }
body { margin: 0; padding: 1.25rem; background: Canvas; color: CanvasText; }
main { max-width: 78rem; margin: auto; }
h1 { margin: 0; font-size: 1.7rem; } h2 { margin: 0; font-size: 1.2rem; } h3 { margin: 0 0 .65rem; font-size: 1rem; }
p { margin: .35rem 0; color: GrayText; } a { color: LinkText; } code { overflow-wrap: anywhere; }
.hero, .section-heading, .card-heading { display: flex; gap: .8rem; align-items: start; justify-content: space-between; }
.hero { margin-bottom: 1rem; } .panel, .card, .notice { border: 1px solid color-mix(in srgb, CanvasText 28%, transparent); border-radius: .65rem; }
.panel { margin: 1rem 0; padding: 1rem; background: color-mix(in srgb, Canvas 94%, CanvasText); } .card { padding: .9rem; background: Canvas; }
.grid { display: grid; gap: .8rem; margin-top: .8rem; } .grid-2 { grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr)); } .grid-3 { grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); }
.badge { display: inline-block; padding: .12rem .45rem; border: 1px solid currentColor; border-radius: 999px; font-size: .82rem; white-space: nowrap; } .badge-ready, .badge-enabled, .badge-complete { color: #258346; } .badge-degraded, .badge-current, .badge-attention { color: #a66a00; } .badge-failed, .badge-disabled, .badge-unavailable { color: #b3261e; }
dl { display: grid; grid-template-columns: minmax(7rem, auto) 1fr; gap: .25rem .65rem; margin: 0; } dt { color: GrayText; } dd { margin: 0; min-width: 0; }
.count-list { list-style: none; margin: 0; padding: 0; } .count-list li { display: flex; justify-content: space-between; gap: .75rem; padding: .18rem 0; }
.table-wrap { overflow-x: auto; } table { border-collapse: collapse; width: 100%; margin-top: .7rem; } th, td { padding: .45rem; border-bottom: 1px solid color-mix(in srgb, CanvasText 22%, transparent); text-align: left; vertical-align: top; }
.notice { margin-top: .8rem; padding: .75rem; } .notice ul { margin: .45rem 0 0 1.2rem; padding: 0; } .workflow { list-style: none; padding: 0; margin: .8rem 0; display: grid; gap: .45rem; } .workflow-step { display: flex; justify-content: space-between; gap: .75rem; padding: .5rem .65rem; border-left: .25rem solid GrayText; background: Canvas; }
.migration-progress { margin-top: .8rem; padding: .75rem; border: 1px solid color-mix(in srgb, CanvasText 22%, transparent); border-radius: .5rem; } .progress-heading { display: flex; justify-content: space-between; gap: .75rem; } progress { width: 100%; height: 1rem; margin-top: .45rem; } .refresh-status { margin-top: .8rem; } .empty { font-style: italic; } .button-link { white-space: nowrap; }
</style>
</head>
<body>
<main>
<header class="hero"><div><h1>PLUR1BUS</h1><p>Operator dashboard for isolated, long-term memory.</p></div>${renderBadge(status.schemaVersion === 2 ? "ready" : "unavailable")}</header>
<section class="notice"><strong>Read-only control tab.</strong> The published OpenClaw Beta-3 tab grants only read scope. Use <a href="/config">OpenClaw Config</a>, <a href="/secrets">OpenClaw Secrets</a>, and the typed authenticated PLUR1BUS actions for changes.</section>
${renderMemoryHealth(status.memoryHealth, status.providers)}
${renderWorkspaceMatrix(status.workspaceMatrix)}
${renderFeatureControls(status.featureCards)}
${renderCredentials(status.credentials)}
${renderEmbeddingDimensionPlanner(status.embeddingDimensionProfiles)}
${renderModelPreparation(status.modelPreparation)}
${renderReembeddingWorkflow(status.reembeddingWorkflow)}
</main>
</body>
</html>`;
}

/** Create the authenticated, strictly read-only status page handler. */
export function createControlUiHttpHandler({ getProjection } = {}) {
  if (typeof getProjection !== "function") throw new Error("PLUR1BUS control projection is required");
  return async (request, response) => {
    if (request?.method !== "GET" && request?.method !== "HEAD") {
      response.statusCode = 405;
      response.setHeader("allow", "GET, HEAD");
      setHeaders(response, "text/plain; charset=utf-8");
      response.end("Method not allowed");
      return true;
    }
    try {
      const projection = await getProjection({ surface: "http" });
      const body = renderProjection(projection);
      response.statusCode = 200;
      setHeaders(response);
      response.end(request.method === "HEAD" ? "" : body);
    } catch {
      response.statusCode = 503;
      setHeaders(response, "text/plain; charset=utf-8");
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

/** Register Beta-3 read surfaces with capability detection and no write bridge. */
export function registerControlUiRuntime({ api, getProjection } = {}) {
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

  const registerDescriptor = api.session?.controls?.registerControlUiDescriptor;
  if (typeof api.registerHttpRoute !== "function" || typeof registerDescriptor !== "function") {
    api.logger?.warn?.("memory-lancedb-namespaced: OpenClaw Control UI tab capability unavailable; Gateway status remains active");
    return { tabRegistered: false };
  }

  api.registerHttpRoute({
    path: CONTROL_UI_PATH,
    auth: "gateway",
    match: "exact",
    handler: createControlUiHttpHandler({ getProjection }),
  });
  registerDescriptor({
    surface: "tab",
    id: "plur1bus",
    label: "PLUR1BUS",
    description: "Workspace memory, providers, and migration status",
    path: CONTROL_UI_PATH,
    icon: "database",
    group: "control",
    requiredScopes: ["operator.read"],
  });
  return { tabRegistered: true };
}
