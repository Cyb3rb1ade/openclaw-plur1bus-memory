import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { createFeatureCronGatewayHandler, executeFeatureCronCli } from "../lib/setup/feature-cron-plugin-runtime.js";

const RELOAD = "PluginInstanceUnavailableError: Plugin memory-lancedb-namespaced was reloaded or disabled; use its current tools.";
const gatewayError = (message = RELOAD, gatewayCode = "UNAVAILABLE", name = "GatewayClientRequestError") =>
  Object.assign(new Error(message), { name, gatewayCode });
const quiet = { warn() {} };

// The transport is the external boundary. The replacement's handler and feature
// execution are real, so keeping the old generation or replaying work breaks this.
test("reload retry sends a fresh RPC to the replacement and executes the feature once", async () => {
  const executed = [];
  const requests = [];
  const delays = [];
  let output = "";
  let currentHandler = async () => { throw gatewayError(); };
  const replacement = createFeatureCronGatewayHandler({
    config: {}, logger: quiet,
    runFeatureCommand: async (ctx) => { executed.push(ctx.args); return { text: "NO_REPLY" }; },
  });
  const reply = await executeFeatureCronCli({
    agentId: "main", feature: "afterthought",
    callGateway: async (method, _opts, params, auth) => {
      requests.push({ method, params, auth });
      let result;
      await currentHandler({ params, respond(ok, payload, error) {
        if (!ok) throw gatewayError(error.message, error.code);
        result = payload;
      } });
      return result;
    },
    wait: async (ms) => { delays.push(ms); currentHandler = replacement; },
    write: (text) => { output += text; },
  });
  assert.deepEqual(reply, { text: "NO_REPLY" });
  assert.deepEqual(executed, ["internal afterthought"]);
  assert.equal(output, "NO_REPLY\n");
  assert.deepEqual(delays, [5000]);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((r) => r.method === "plur1bus.feature.run" && r.params.agentId === "main" && r.params.feature === "afterthought"));
  assert.ok(requests.every((r) => r.auth.scopes.length === 1 && r.auth.scopes[0] === "operator.write"));
});

test("a reload-like error inside admitted feature work is not replayed", async () => {
  const executed = [];
  const delays = [];
  const handler = createFeatureCronGatewayHandler({
    config: {}, logger: quiet,
    runFeatureCommand: async (ctx) => {
      executed.push(ctx.args);
      throw Object.assign(new Error("Plugin memory-lancedb-namespaced was reloaded or disabled; use its current tools."), { name: "PluginInstanceUnavailableError" });
    },
  });
  await assert.rejects(executeFeatureCronCli({
    agentId: "main", feature: "afterthought", write() {}, wait: async (ms) => { delays.push(ms); },
    callGateway: async (_method, _opts, params) => {
      let frame;
      await handler({ params, respond(...args) { frame = args; } });
      if (!frame[0]) throw gatewayError(frame[2].message, frame[2].code);
      return frame[1];
    },
  }), (error) => error.gatewayCode === "plur1bus_feature_cron_error");
  assert.deepEqual(executed, ["internal afterthought"]);
  assert.deepEqual(delays, []);
});

test("persistent retirement exhausts three retries and reports the original error without stdout", async () => {
  const failure = gatewayError();
  let calls = 0;
  let output = "";
  const delays = [];
  await assert.rejects(executeFeatureCronCli({
    agentId: "main", feature: "afterthought",
    callGateway: async () => { calls++; throw failure; },
    wait: async (ms) => { delays.push(ms); }, logger: quiet,
    write: (text) => { output += text; },
  }), (error) => error === failure);
  assert.equal(calls, 4);
  assert.deepEqual(delays, [5000, 10000, 15000]);
  assert.equal(output, "");
});

for (const [label, error] of [
  ["generic unavailable", gatewayError("gateway is busy")],
  ["another plugin", gatewayError(RELOAD.replace("memory-lancedb-namespaced", "other-plugin"))],
  ["plugin handler failure", gatewayError(RELOAD, "plur1bus_feature_cron_error")],
  ["plain local error", new Error(RELOAD)],
  ["permission denial", gatewayError(RELOAD, "FORBIDDEN")],
  ["transport timeout", gatewayError(RELOAD, "CLIENT_TIMEOUT", "GatewayProtocolRequestTimeoutError")],
]) {
  test(`does not retry ${label}`, async () => {
    let calls = 0;
    const delays = [];
    await assert.rejects(executeFeatureCronCli({
      agentId: "main", feature: "afterthought",
      callGateway: async () => { calls++; throw error; },
      wait: async (ms) => { delays.push(ms); }, logger: quiet, write() {},
    }), (value) => value === error);
    assert.equal(calls, 1);
    assert.deepEqual(delays, []);
  });
}

test("an unrelated failure after a stale rejection stops retries immediately", async () => {
  const failure = gatewayError("feature failed after replacement", "plur1bus_feature_cron_error");
  let calls = 0;
  const delays = [];
  await assert.rejects(executeFeatureCronCli({
    agentId: "main", feature: "afterthought",
    callGateway: async () => { calls++; throw calls === 1 ? gatewayError() : failure; },
    wait: async (ms) => { delays.push(ms); }, logger: quiet, write() {},
  }), (error) => error === failure);
  assert.equal(calls, 2);
  assert.deepEqual(delays, [5000]);
});

test("a cancelled backoff stops before another request", async () => {
  const aborted = Object.assign(new Error("cancelled"), { name: "AbortError" });
  let calls = 0;
  await assert.rejects(executeFeatureCronCli({
    agentId: "main", feature: "afterthought",
    callGateway: async () => { calls++; throw gatewayError(); },
    wait: async () => { throw aborted; }, logger: quiet, write() {},
  }), (error) => error === aborted);
  assert.equal(calls, 1);
});

test("a recovered default CLI invocation emits only NO_REPLY and no deliverable stderr", () => {
  const moduleUrl = new URL("../lib/setup/feature-cron-plugin-runtime.js", import.meta.url).href;
  const script = `import { executeFeatureCronCli } from ${JSON.stringify(moduleUrl)};
    let calls = 0;
    await executeFeatureCronCli({ agentId: "main", feature: "afterthought", wait: async () => {},
      callGateway: async () => {
        if (++calls === 1) throw Object.assign(new Error(${JSON.stringify(RELOAD)}), { name: "GatewayClientRequestError", gatewayCode: "UNAVAILABLE" });
        return { reply: { text: "NO_REPLY" } };
      }
    });`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "NO_REPLY\n");
  assert.equal(result.stderr, "");
});
