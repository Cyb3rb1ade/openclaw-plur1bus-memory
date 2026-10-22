import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import * as writes from "../lib/setup/control-ui-write.js";
import * as jev from "../lib/jev-chunk-decider.js";
import { buildControlPlaneProjection } from "../lib/control-plane-projection.js";
import { createControlUiHttpHandler, registerControlUiRuntime } from "../lib/setup/control-ui-plugin-runtime.js";

const PATH = "/plugins/memory-lancedb-namespaced/control";
const SECRET = "jev-test-secret-never-render";
function response() {
  return {
    statusCode: 0, body: "", headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(body = "") { this.body = body; },
  };
}
function request(pairs, method = "POST") {
  const body = new URLSearchParams(pairs).toString();
  return {
    method, url: method === "GET" ? `${PATH}?${body}` : PATH,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    async *[Symbol.asyncIterator]() { yield Buffer.from(body); },
  };
}
function setup(config = {}, env = {}, mode = "all") {
  const draft = { plugins: { entries: { "memory-lancedb-namespaced": { config } } } };
  const warnings = [];
  const deps = {
    setJevApiKey: typeof writes.createJevApiKeyMutator === "function"
      ? writes.createJevApiKeyMutator({ api: { runtime: { config: { mutateConfigFile: async ({ mutate }) => mutate(draft) } } } })
      : undefined,
    logger: { warn: (message) => warnings.push(message) },
  };
  const tokens = writes.createFormTokenStore();
  const handler = createControlUiHttpHandler({
    getProjection: async () => buildControlPlaneProjection({ config: draft.plugins.entries["memory-lancedb-namespaced"].config, env }),
    write: { mode, tokens, applyAction: (args) => writes.applyControlUiWriteAction({ ...args, deps }) },
  });
  return { draft, warnings, deps, tokens, handler, config: () => draft.plugins.entries["memory-lancedb-namespaced"].config };
}

test("Jev runtime uses explicit keys first, then the selected environment variable", () => {
  assert.equal(typeof jev.resolveJevApiKey, "function");
  assert.equal(jev.resolveJevApiKey({ apiKey: ` ${SECRET} `, apiKeyEnv: "CUSTOM_JEV" }, { CUSTOM_JEV: "environment" }), SECRET);
  assert.equal(jev.resolveJevApiKey({ apiKey: "  ", apiKeyEnv: " CUSTOM_JEV " }, { CUSTOM_JEV: " environment " }), "environment");
  assert.equal(jev.resolveJevApiKey({}, { TYPESAFE_API_KEY: "default-env" }), "default-env");
  assert.equal(jev.resolveJevApiKey({ apiKeyEnv: "CUSTOM_JEV" }, { TYPESAFE_API_KEY: "wrong-env" }), "");
});

test("Jev projection reports only presence and the winning source", () => {
  const cases = [
    [{ apiKey: SECRET, apiKeyEnv: "CUSTOM_JEV" }, { CUSTOM_JEV: "environment-secret" }, true, "config"],
    [{ apiKey: "  ", apiKeyEnv: "CUSTOM_JEV" }, { CUSTOM_JEV: "environment-secret" }, true, "environment"],
    [{}, { TYPESAFE_API_KEY: "environment-secret" }, true, "environment"],
    [{}, {}, false, "missing"],
  ];
  for (const [captureChunkingJev, env, configured, source] of cases) {
    const projection = buildControlPlaneProjection({ config: { captureChunkingJev }, env });
    assert.equal(projection.captureChunking.jevKey, configured);
    assert.equal(projection.captureChunking.jevKeySource, source);
    assert.doesNotMatch(JSON.stringify(projection), /jev-test-secret|environment-secret/);
  }
});

test("Jev key mutator saves and replaces only the key, leaving the running object unchanged", async () => {
  assert.equal(typeof writes.createJevApiKeyMutator, "function");
  const running = { autoCapture: true, captureChunkingJev: { model: "custom-model", apiKeyEnv: "CUSTOM_JEV", minConfidence: 0.9 } };
  const state = setup(running);
  assert.deepEqual(await state.deps.setJevApiKey({ apiKey: ` ${SECRET} ` }), { changed: true });
  assert.deepEqual(state.config().captureChunkingJev, { model: "custom-model", apiKeyEnv: "CUSTOM_JEV", minConfidence: 0.9, apiKey: SECRET });
  assert.equal(running.captureChunkingJev.apiKey, undefined);
  await state.deps.setJevApiKey({ apiKey: "replacement-key" });
  assert.equal(state.config().captureChunkingJev.apiKey, "replacement-key");
  assert.equal(state.config().autoCapture, true);
});

test("blank saves do not write; explicit removal restores the environment fallback", async () => {
  assert.equal(typeof writes.createJevApiKeyMutator, "function");
  const state = setup({ captureChunkingJev: { apiKey: SECRET, apiKeyEnv: "CUSTOM_JEV", model: "custom-model" } });
  const original = state.config();
  assert.deepEqual(await state.deps.setJevApiKey({ apiKey: "  " }), { changed: false });
  assert.equal(state.config(), original);
  assert.deepEqual(await state.deps.setJevApiKey({ remove: true }), { changed: true });
  assert.equal(Object.hasOwn(state.config().captureChunkingJev, "apiKey"), false);
  assert.equal(state.config().captureChunkingJev.model, "custom-model");
  assert.equal(jev.resolveJevApiKey(state.config().captureChunkingJev, { CUSTOM_JEV: "fallback" }), "fallback");
});

test("Jev actions reject invalid keys and do not echo credential-bearing errors", async () => {
  const warnings = [];
  const deps = { setJevApiKey: async () => { throw new Error(`write failed: ${SECRET}`); }, logger: { warn: (message) => warnings.push(message) } };
  for (const api_key of ["x".repeat(1025), "key\nheader", "key\u0000value"]) {
    assert.deepEqual(await writes.applyControlUiWriteAction({ action: "capture.jevKey.save", form: new URLSearchParams({ api_key }), mode: "all", deps }), { ok: false, code: "denied_value" });
  }
  const result = await writes.applyControlUiWriteAction({ action: "capture.jevKey.save", form: new URLSearchParams({ api_key: SECRET }), mode: "all", deps });
  assert.deepEqual(result, { ok: false, code: "failed" });
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(JSON.stringify({ result, warnings }), /jev-test-secret/);
});

test("Jev request failures never log the bearer credential echoed by a transport", async () => {
  const warnings = [];
  const decide = jev.createJevChunkDecider({
    apiKey: SECRET,
    fetchImpl: async () => { throw new Error(`Request failed for credential ${SECRET}`); },
    logger: { warn: (message) => warnings.push(message) },
  });
  assert.deepEqual(await decide("Independent topics."), { storage: "both", reason: "error" });
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(JSON.stringify(warnings), /jev-test-secret/);
});

test("Jev form POST uses the existing single-use token and explicit remove action", async () => {
  const state = setup({ captureChunkingJev: { apiKeyEnv: "CUSTOM_JEV" } });
  const token = state.tokens.issue();
  const first = response();
  await state.handler(request({ action: "capture.jevKey.save", api_key: SECRET, form_token: token }), first);
  assert.equal(first.headers.location, `${PATH}?result=jev_key_saved`);
  assert.equal(state.config().captureChunkingJev.apiKey, SECRET);
  assert.doesNotMatch(JSON.stringify(first), /jev-test-secret/);
  const replay = response();
  await state.handler(request({ action: "capture.jevKey.remove", form_token: token }), replay);
  assert.match(replay.headers.location, /result=denied_token$/);
  assert.equal(state.config().captureChunkingJev.apiKey, SECRET);
  const blank = response();
  await state.handler(request({ action: "capture.jevKey.save", api_key: "  ", form_token: state.tokens.issue() }), blank);
  assert.match(blank.headers.location, /result=jev_key_unchanged$/);
  assert.equal(state.config().captureChunkingJev.apiKey, SECRET);
  const remove = response();
  await state.handler(request({ action: "capture.jevKey.remove", form_token: state.tokens.issue() }), remove);
  assert.match(remove.headers.location, /result=jev_key_removed$/);
  assert.equal(Object.hasOwn(state.config().captureChunkingJev, "apiKey"), false);
});

test("credential GET requests are refused before consuming tokens or changing config", async () => {
  const state = setup({});
  const token = state.tokens.issue();
  const res = response();
  await state.handler(request({ action: "capture.jevKey.save", api_key: SECRET, form_token: token, via: "fetch" }, "GET"), res);
  assert.equal(res.statusCode, 405);
  assert.equal(state.tokens.consume(token), true);
  assert.equal(state.config().captureChunkingJev, undefined);
  assert.doesNotMatch(JSON.stringify(res), /jev-test-secret/);
});

test("read-only and reranker-only modes do not permit Jev credential changes", async () => {
  for (const mode of ["off", "reranker"]) {
    const state = setup({ captureChunkingJev: { apiKey: SECRET } }, {}, mode);
    const res = response();
    await state.handler({ method: "GET", url: PATH }, res);
    assert.doesNotMatch(String(res.body), /type="password"|value="capture\.jevKey\./);
    const result = await writes.applyControlUiWriteAction({ action: "capture.jevKey.remove", form: new URLSearchParams(), mode, deps: state.deps });
    assert.deepEqual(result, { ok: false, code: "denied_mode" });
    assert.equal(state.config().captureChunkingJev.apiKey, SECRET);
  }
});

function dashboardScript(html) {
  const listeners = {};
  const messages = [];
  const fetches = [];
  const navigation = [];
  const status = { textContent: "" };
  const button = { disabled: false, addEventListener: (event, fn) => { listeners[event] = fn; } };
  const form = {
    getAttribute: (name) => name === "action" ? PATH : null,
    querySelectorAll: () => [button],
    addEventListener() {},
  };
  const parent = { postMessage: (message, origin) => messages.push({ message, origin }) };
  const window = {
    parent,
    location: { origin: "http://127.0.0.1:18789", replace: (url) => navigation.push(url) },
    addEventListener: (event, fn) => { listeners[event] = fn; },
  };
  runInNewContext(html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1], {
    document: { querySelectorAll: () => [form], getElementById: () => status },
    URLSearchParams,
    FormData: class { *[Symbol.iterator]() { yield ["action", "capture.jevKey.save"]; yield ["api_key", SECRET]; yield ["form_token", "form-token-with-sufficient-length"]; } },
    fetch: async (url, init) => { fetches.push({ url, init }); },
    window, console,
    setTimeout: () => 1,
    clearTimeout() {},
  });
  return { listeners, messages, fetches, parent, navigation, status };
}

test("Jev editor renders an empty password and passes the key through the native bridge", async () => {
  const state = setup({ captureChunkingJev: { apiKey: SECRET } });
  const res = response();
  await state.handler({ method: "GET", url: PATH, headers: { host: "127.0.0.1:18789" } }, res);
  const html = String(res.body);
  assert.match(html, /type="password"[^>]*name="api_key"/);
  assert.match(html, /Jev key: configured[^<]*\(config\)/);
  assert.doesNotMatch(html, /jev-test-secret/);
  const script = dashboardScript(html);
  assert.equal(script.messages.length, 1, "the page probes without sending credentials");
  assert.equal(script.messages[0].message.action, "probe");
  assert.doesNotMatch(JSON.stringify(script.messages), /jev-test-secret/);
  const requestId = script.messages[0].message.requestId;
  script.listeners.message({ source: script.parent, origin: "http://127.0.0.1:18789", data: { type: "plur1bus-jev-key-result", requestId, code: "ready" } });
  script.listeners.click({ preventDefault() {} });
  assert.equal(script.fetches.length, 0, "credentials do not use iframe HTTP authentication");
  assert.equal(script.messages[1].message.action, "save");
  assert.equal(script.messages[1].message.apiKey, SECRET);
  assert.equal(script.messages[1].origin, "http://127.0.0.1:18789");
  assert.equal(script.messages[1].message.formToken, "form-token-with-sufficient-length");
  script.listeners.message({ source: script.parent, origin: "http://127.0.0.1:18789", data: { type: "plur1bus-jev-key-result", requestId, code: "jev_key_saved", apiKey: "untrusted-extra" } });
  assert.equal(script.navigation.length, 0, "open response shapes are refused");
  script.listeners.message({ source: script.parent, origin: "http://127.0.0.1:18789", data: { type: "plur1bus-jev-key-result", requestId, code: "jev_key_saved" } });
  assert.deepEqual(script.navigation, [`${PATH}?result=jev_key_saved`]);
});

test("Jev editor refuses untrusted bridge replies and preserves fallback status", async () => {
  const state = setup({});
  const res = response();
  await state.handler({ method: "GET", url: PATH }, res);
  assert.match(String(res.body), /Custom plugin UI/);
  const script = dashboardScript(String(res.body));
  const requestId = script.messages[0].message.requestId;
  for (const bad of [
    { source: {}, origin: "http://127.0.0.1:18789" },
    { source: script.parent, origin: "https://attacker.invalid" },
  ]) {
    script.listeners.message({ ...bad, data: { type: "plur1bus-jev-key-result", requestId, code: "ready" } });
  }
  script.listeners.click({ preventDefault() {} });
  assert.equal(script.messages.length, 1, "no key is sent without a trusted readiness acknowledgement");
  assert.equal(script.fetches.length, 0);
  assert.match(script.status.textContent, /Custom plugin UI|unavailable/);
});

test("Jev credential UI remains behind the dashboard operator.write registration", () => {
  let route; let descriptor;
  registerControlUiRuntime({
    api: { registerGatewayMethod() {}, registerHttpRoute(value) { route = value; }, registerControlUiDescriptor(value) { descriptor = value; } },
    getProjection: async () => ({}),
    write: { mode: "all", tokens: writes.createFormTokenStore(), applyAction: async () => ({ code: "failed" }) },
  });
  assert.equal(route.auth, "gateway");
  assert.deepEqual(descriptor.requiredScopes, ["operator.read", "operator.write"]);
});

test("Jev apiKey is accepted by the plugin contract and classified sensitive", () => {
  const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
  assert.equal(manifest.configSchema.properties.captureChunkingJev.properties.apiKey.type, "string");
  assert.equal(manifest.uiHints["captureChunkingJev.apiKey"].sensitive, true);
});


test("Jev Gateway writer is operator.write scoped, typed, token-bound and returns only a result code", async () => {
  const state = setup({});
  const methods = new Map();
  registerControlUiRuntime({
    api: {
      registerGatewayMethod: (name, handler, options) => methods.set(name, { handler, options }),
      registerHttpRoute() {}, registerControlUiDescriptor() {},
    },
    getProjection: async () => ({}),
    write: { mode: "all", tokens: state.tokens, applyAction: (args) => writes.applyControlUiWriteAction({ ...args, deps: state.deps }) },
  });
  const method = methods.get("plur1bus.control.jevKey");
  assert.ok(method, "the key writer is registered");
  assert.equal(method.options.scope, "operator.write");
  const call = async (params) => {
    let reply;
    await method.handler({ params, respond: (...args) => { reply = args; } });
    return reply;
  };
  const token = state.tokens.issue();
  assert.deepEqual(await call({ action: "save", apiKey: SECRET, formToken: token, method: "config.set" }), [true, { code: "denied_value" }]);
  assert.equal(state.config().captureChunkingJev, undefined);
  assert.deepEqual(await call({ action: "save", apiKey: SECRET, formToken: token }), [true, { code: "jev_key_saved" }]);
  assert.equal(state.config().captureChunkingJev.apiKey, SECRET);
  assert.deepEqual(await call({ action: "remove", formToken: token }), [true, { code: "denied_token" }]);
});

function nativeBridge(host = {}) {
  const entry = new URL("../dist/control-ui/jev-key/index.js", import.meta.url);
  assert.ok(existsSync(entry), "the packaged native bridge exists");
  const listeners = new Map();
  const replies = [];
  const requests = [];
  const child = { postMessage: (message, origin) => replies.push({ message, origin }) };
  const frames = [{ isConnected: true, contentWindow: child, src: `http://127.0.0.1:18789${PATH}` }];
  const sandbox = {
    window: {
      location: { origin: "http://127.0.0.1:18789", href: "http://127.0.0.1:18789/" },
      addEventListener: (event, fn) => listeners.set(event, fn),
      removeEventListener: (event) => listeners.delete(event),
    },
    document: { querySelectorAll: () => frames }, URL,
    bridge: undefined,
  };
  runInNewContext(readFileSync(entry, "utf8").replace("export default", "bridge ="), sandbox);
  const dispose = sandbox.bridge.activate({
    connection: { connected: true, canWrite: true },
    signal: { aborted: false },
    request: async (method, params) => { requests.push({ method, params }); return { code: "jev_key_saved", apiKey: "must-not-forward" }; },
    ...host,
  });
  const send = (data, overrides = {}) => listeners.get("message")({ source: child, origin: "null", ports: [], data, ...overrides });
  return { send, replies, requests, child, frames, dispose, listeners };
}

test("native bridge only forwards typed Jev operations from the exact dashboard iframe", async () => {
  const bridge = nativeBridge();
  const base = { type: "plur1bus-jev-key-request", requestId: "request-id-123456789", action: "save", apiKey: SECRET, formToken: "csrf-token-123456789" };
  await bridge.send(base, { source: {} });
  await bridge.send(base, { origin: "https://attacker.invalid" });
  await bridge.send(base, { ports: [{}] });
  await bridge.send({ ...base, method: "config.set" });
  await bridge.send({ ...base, action: "config.set" });
  await bridge.send({ ...base, apiKey: "x".repeat(1025) });
  bridge.frames[0].src = "https://attacker.invalid/plugins/memory-lancedb-namespaced/control";
  await bridge.send(base);
  bridge.frames[0].src = `http://127.0.0.1:18789${PATH}/other`;
  await bridge.send(base);
  assert.equal(bridge.requests.length, 0);
  bridge.frames[0].src = `http://127.0.0.1:18789${PATH}`;
  await bridge.send(base);
  assert.equal(bridge.requests.length, 1);
  assert.equal(bridge.requests[0].method, "plur1bus.control.jevKey");
  assert.equal(bridge.requests[0].params.apiKey, SECRET);
  assert.deepEqual(JSON.parse(JSON.stringify(bridge.replies)), [{ message: { type: "plur1bus-jev-key-result", requestId: "request-id-123456789", code: "jev_key_saved" }, origin: "*" }]);
  bridge.dispose();
  assert.equal(bridge.listeners.has("message"), false);
});

test("native bridge probes carry no secret and never calls Gateway without write authority", async () => {
  for (const connection of [{ connected: false, canWrite: true }, { connected: true, canWrite: false }]) {
    const bridge = nativeBridge({ connection });
    await bridge.send({ type: "plur1bus-jev-key-request", requestId: "request-id-123456789", action: "probe" });
    assert.equal(bridge.replies[0].message.code, "unavailable");
    await bridge.send({ type: "plur1bus-jev-key-request", requestId: "request-id-123456789", action: "remove", formToken: "csrf-token-123456789" });
    assert.equal(bridge.requests.length, 0);
    bridge.dispose();
  }
});
