import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CONTROL_UI_GATEWAY_METHOD,
  CONTROL_UI_PATH,
  createControlUiHttpHandler,
  registerControlUiRuntime,
} from "../lib/setup/control-ui-plugin-runtime.js";

function fakeResponse() {
  const headers = new Map();
  return {
    statusCode: 0,
    body: undefined,
    setHeader(name, value) { headers.set(String(name).toLowerCase(), value); },
    getHeader(name) { return headers.get(String(name).toLowerCase()); },
    end(body = "") { this.body = body; },
  };
}

describe("PLUR1BUS Beta-3 Control UI runtime", () => {
  it("registers one read-scoped status method and one authenticated external tab", () => {
    const gatewayMethods = [];
    const routes = [];
    const descriptors = [];
    registerControlUiRuntime({
      api: {
        registerGatewayMethod: (...args) => gatewayMethods.push(args),
        registerHttpRoute: (route) => routes.push(route),
        session: { controls: { registerControlUiDescriptor: (descriptor) => descriptors.push(descriptor) } },
        logger: { warn() {} },
      },
      getProjection: async () => ({ schemaVersion: 1 }),
    });

    assert.equal(gatewayMethods.length, 1);
    assert.equal(gatewayMethods[0][0], CONTROL_UI_GATEWAY_METHOD);
    assert.deepStrictEqual(gatewayMethods[0][2], { scope: "operator.read" });
    assert.deepStrictEqual(routes, [{
      path: CONTROL_UI_PATH,
      auth: "gateway",
      match: "exact",
      handler: routes[0].handler,
    }]);
    assert.deepStrictEqual(descriptors, [{
      surface: "tab",
      id: "plur1bus",
      label: "PLUR1BUS",
      description: "Workspace memory, providers, and migration status",
      path: CONTROL_UI_PATH,
      icon: "database",
      group: "control",
      requiredScopes: ["operator.read"],
    }]);
  });

  it("renders only escaped projection data under a locked-down CSP", async () => {
    const secret = "sentinel-secret-material";
    const handler = createControlUiHttpHandler({
      getProjection: async () => ({
        schemaVersion: 1,
        title: "<unsafe>",
        credentials: { embedding: { status: "configured", source: "store" } },
      }),
    });
    const response = fakeResponse();

    assert.equal(await handler({ method: "GET", url: CONTROL_UI_PATH }, response), true);
    assert.equal(response.statusCode, 200);
    assert.match(response.getHeader("content-security-policy"), /default-src 'none'/);
    assert.equal(response.getHeader("cache-control"), "no-store, max-age=0");
    assert.match(response.body, /&lt;unsafe&gt;/);
    assert.doesNotMatch(response.body, /<unsafe>|<script|<form|fetch\s*\(/i);
    assert.doesNotMatch(response.body, new RegExp(secret));
  });

  it("supports HEAD and rejects every mutation method", async () => {
    let projections = 0;
    const handler = createControlUiHttpHandler({
      getProjection: async () => { projections += 1; return { schemaVersion: 1 }; },
    });
    const head = fakeResponse();
    assert.equal(await handler({ method: "HEAD", url: CONTROL_UI_PATH }, head), true);
    assert.equal(head.statusCode, 200);
    assert.equal(head.body, "");
    assert.equal(projections, 1);

    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = fakeResponse();
      assert.equal(await handler({ method, url: CONTROL_UI_PATH }, response), true);
      assert.equal(response.statusCode, 405, method);
      assert.equal(response.getHeader("allow"), "GET, HEAD");
    }
    assert.equal(projections, 1, "mutation requests never reach projection code");
  });

  it("validates the Gateway request and never forwards projection errors", async () => {
    const registrations = [];
    registerControlUiRuntime({
      api: {
        registerGatewayMethod: (...args) => registrations.push(args),
        registerHttpRoute() {},
        session: { controls: { registerControlUiDescriptor() {} } },
        logger: { warn() {} },
      },
      getProjection: async () => { throw new Error("sentinel-secret-must-not-leak"); },
    });
    const handler = registrations[0][1];
    const responses = [];
    await handler({ params: { unexpected: true }, respond: (...args) => responses.push(args) });
    await handler({ params: {}, respond: (...args) => responses.push(args) });

    assert.equal(responses[0][0], false);
    assert.equal(responses[1][0], false);
    assert.doesNotMatch(JSON.stringify(responses), /sentinel-secret-must-not-leak/);
  });

  it("keeps the Gateway status method when the external-tab capability is absent", () => {
    const methods = [];
    const warnings = [];
    registerControlUiRuntime({
      api: {
        registerGatewayMethod: (...args) => methods.push(args),
        logger: { warn: (message) => warnings.push(message) },
      },
      getProjection: async () => ({ schemaVersion: 1 }),
    });
    assert.equal(methods.length, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Control UI tab capability unavailable/);
  });
});
