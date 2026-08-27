export const CONTROL_UI_GATEWAY_METHOD = "plur1bus.control.status";
export const CONTROL_UI_PATH = "/plugins/memory-lancedb-namespaced/control";

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

function renderProjection(projection) {
  const serialized = escapeHtml(JSON.stringify(projection, null, 2));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PLUR1BUS status</title>
<style>
:root { color-scheme: light dark; font: 14px/1.5 system-ui, sans-serif; }
body { margin: 0; padding: 1.25rem; background: Canvas; color: CanvasText; }
main { max-width: 72rem; margin: auto; }
h1 { margin: 0 0 .4rem; font-size: 1.4rem; }
p { margin: .25rem 0 1rem; color: GrayText; }
pre { overflow: auto; padding: 1rem; border: 1px solid GrayText; border-radius: .5rem; background: Field; color: FieldText; }
a { color: LinkText; }
</style>
</head>
<body>
<main>
<h1>PLUR1BUS</h1>
<p>Read-only runtime status. Configuration and secrets remain protected by OpenClaw operator scopes.</p>
<p><a href="/config">OpenClaw Config</a> · <a href="/secrets">OpenClaw Secrets</a></p>
<pre>${serialized}</pre>
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
