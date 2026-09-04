import { strict as assert } from "node:assert";
import test from "node:test";

import {
  CONTROL_UI_ACTION_FIELD,
  CONTROL_UI_FORM_TOKEN_FIELD,
  RERANKER_CHOICES,
  activeRerankerChoiceId,
  applyControlUiWriteAction,
  createConfirmationStore,
  createFormTokenStore,
  embeddingPlanTarget,
  rerankerChoice,
  rerankerConfigPatch,
  rerankerKeyConfigured,
} from "../lib/setup/control-ui-write.js";
import { createControlUiHttpHandler, registerControlUiRuntime } from "../lib/setup/control-ui-plugin-runtime.js";
import { buildControlPlaneProjection } from "../lib/control-plane-projection.js";
import { resolveEffectiveConfig } from "../lib/setup/config-contract.js";

function collectingResponse() {
  const headers = new Map();
  return {
    statusCode: 0,
    body: "",
    headers,
    setHeader(name, value) { headers.set(String(name).toLowerCase(), value); },
    getHeader(name) { return headers.get(String(name).toLowerCase()); },
    end(body = "") { this.body = body; },
  };
}

function formRequest(pairs, { method = "POST" } = {}) {
  const body = new URLSearchParams(pairs).toString();
  return {
    method,
    url: "/plugins/memory-lancedb-namespaced/control",
    headers: { "content-type": "application/x-www-form-urlencoded", "content-length": String(Buffer.byteLength(body)) },
    async *[Symbol.asyncIterator]() { yield Buffer.from(body); },
  };
}

const projectionFor = (config = {}) => buildControlPlaneProjection({
  config: resolveEffectiveConfig(config),
  capabilities: { reranker: true },
  providers: { reranker: { provider: "local-transformers", model: RERANKER_CHOICES[0].model } },
});

test("the reranker choices are the values the config schema accepts", () => {
  // 7.5.1 to 7.5.5 told operators to set reranker.provider to "jina", which
  // the schema rejects. Jina reranking is a local model, not a provider.
  const providers = new Set(RERANKER_CHOICES.map((choice) => choice.provider));
  assert.deepEqual([...providers].sort(), ["cohere", "disabled", "local-transformers"]);
  const jina = rerankerChoice("local-jina");
  assert.equal(jina.provider, "local-transformers");
  assert.match(jina.model, /^jinaai\/jina-reranker-v2/);
  assert.match(jina.revision, /^[0-9a-f]{40}$/);
});

test("switching to JinaAI keeps unrelated reranker settings", () => {
  const current = { provider: "local-transformers", enabled: true, timeoutMs: 2500, fallbackOnError: true, local: { model: RERANKER_CHOICES[0].model, revision: RERANKER_CHOICES[0].revision, cacheDir: "/cache" } };
  const next = rerankerConfigPatch(rerankerChoice("local-jina"), current);
  assert.equal(next.provider, "local-transformers");
  assert.equal(next.enabled, true);
  assert.equal(next.timeoutMs, 2500, "unrelated keys survive");
  assert.equal(next.local.cacheDir, "/cache", "unrelated local keys survive");
  assert.equal(next.local.model, rerankerChoice("local-jina").model);
  assert.equal(next.local.revision, rerankerChoice("local-jina").revision);
  // Off is a single explicit shape, not a deletion.
  assert.deepEqual(rerankerConfigPatch(rerankerChoice("disabled"), current).enabled, false);
});

test("the active choice is read off the running config, including the bundled default", () => {
  assert.equal(activeRerankerChoiceId({ reranker: { provider: "local-transformers", enabled: true } }), "local-bge");
  assert.equal(activeRerankerChoiceId({ reranker: { provider: "local-transformers", enabled: true, local: { model: rerankerChoice("local-jina").model } } }), "local-jina");
  assert.equal(activeRerankerChoiceId({ reranker: { provider: "cohere", enabled: true } }), "cohere");
  assert.equal(activeRerankerChoiceId({ reranker: { provider: "cohere", enabled: false } }), "disabled");
});

test("a hosted key counts only when it is actually present", () => {
  assert.equal(rerankerKeyConfigured({ reranker: { apiKeyEnv: "COHERE_API_KEY" } }, { COHERE_API_KEY: "x" }), true);
  assert.equal(rerankerKeyConfigured({ reranker: { apiKeyEnv: "COHERE_API_KEY" } }, {}), false);
  assert.equal(rerankerKeyConfigured({ reranker: { apiKeyEnv: "COHERE_API_KEY" } }, { COHERE_API_KEY: "  " }), false);
  assert.equal(rerankerKeyConfigured({ reranker: { apiKey: "sk-x" } }, {}), true);
  assert.equal(rerankerKeyConfigured({}, {}), false);
});

test("form tokens are single use and bounded", () => {
  let now = 1_000;
  const store = createFormTokenStore({ now: () => now, ttlMs: 1_000, maxTokens: 4 });
  const token = store.issue();
  assert.equal(store.consume(token), true);
  assert.equal(store.consume(token), false, "a token works exactly once");
  const expiring = store.issue();
  now = 3_000;
  assert.equal(store.consume(expiring), false, "an expired token is refused");
  for (let i = 0; i < 10; i += 1) store.issue();
  assert.ok(store.size <= 4, `the store stays bounded, saw ${store.size}`);
  assert.equal(store.consume(""), false);
  assert.equal(store.consume("short"), false);
});

test("a planned target must match the fingerprint preparation verified", () => {
  const target = embeddingPlanTarget("e5-multilingual-384");
  assert.equal(target.fingerprint.provider, "local-transformers");
  assert.equal(target.fingerprint.dimensions, 384);
  assert.throws(
    () => embeddingPlanTarget("e5-multilingual-384", "embedding:v1:sha256:" + "0".repeat(64)),
    /does not match/,
    "a mismatch is refused instead of planning into an unverified generation",
  );
  assert.throws(() => embeddingPlanTarget("not-a-profile"), /unknown embedding preparation profile/);
});

test("write actions respect the configured mode", async () => {
  const calls = [];
  const deps = {
    setReranker: async (choice) => calls.push(choice.id),
    setEmbeddingProfile: async () => calls.push("profile"),
    rerankerKeyConfigured: () => true,
    confirmations: createConfirmationStore(),
  };
  const form = new URLSearchParams({ choice: "local-jina" });
  assert.deepEqual(await applyControlUiWriteAction({ action: "reranker.set", form, mode: "off", deps }), { ok: false, code: "denied_mode" });
  assert.deepEqual(await applyControlUiWriteAction({ action: "reranker.set", form, mode: "reranker", deps }), { ok: true, code: "reranker_switched" });
  assert.deepEqual(
    await applyControlUiWriteAction({ action: "embedding.profile", form: new URLSearchParams({ profile: "e5-multilingual-384" }), mode: "reranker", deps }),
    { ok: false, code: "denied_mode" },
    "the reranker mode does not unlock the embedding target",
  );
  assert.deepEqual(
    await applyControlUiWriteAction({ action: "embedding.profile", form: new URLSearchParams({ profile: "e5-multilingual-384" }), mode: "all", deps }),
    { ok: true, code: "embedding_profile_switched" },
  );
  assert.deepEqual(await applyControlUiWriteAction({ action: "nonsense", form, mode: "all", deps }), { ok: false, code: "denied_action" });
  assert.deepEqual(calls, ["local-jina", "profile"]);
});

test("the hosted reranker is refused while no key is configured", async () => {
  const deps = { setReranker: async () => { throw new Error("must not be called"); }, rerankerKeyConfigured: () => false, confirmations: createConfirmationStore() };
  assert.deepEqual(
    await applyControlUiWriteAction({ action: "reranker.set", form: new URLSearchParams({ choice: "cohere" }), mode: "reranker", deps }),
    { ok: false, code: "denied_key" },
  );
});

test("the migration confirmation never leaves the gateway", async () => {
  const confirmations = createConfirmationStore();
  const applied = [];
  const deps = {
    confirmations,
    preparedTarget: () => ({ profileId: "e5-multilingual-384", fingerprintId: embeddingPlanTarget("e5-multilingual-384").fingerprint && undefined }),
    nextMigrationId: () => "mig-1",
    planReembedding: async () => ({ record: { id: "mig-1" }, confirmation: { token: "reemb_v1_secret" } }),
    applyReembedding: async (request) => applied.push(["apply", request.token]),
    switchReembedding: async (request) => applied.push(["switch", request.token]),
  };
  // Without a fingerprint the plan is refused rather than guessed.
  assert.deepEqual(
    await applyControlUiWriteAction({ action: "reembedding.plan", form: new URLSearchParams(), mode: "all", deps }),
    { ok: false, code: "denied_not_ready" },
  );
  deps.preparedTarget = () => ({ profileId: "e5-multilingual-384", fingerprintId: null });
  assert.equal((await applyControlUiWriteAction({ action: "reembedding.plan", form: new URLSearchParams(), mode: "all", deps })).code, "denied_not_ready");

  const fingerprintId = (await import("../lib/reembedding/fingerprint.js")).embeddingFingerprintId(embeddingPlanTarget("e5-multilingual-384").fingerprint);
  deps.preparedTarget = () => ({ profileId: "e5-multilingual-384", fingerprintId });
  assert.deepEqual(await applyControlUiWriteAction({ action: "reembedding.plan", form: new URLSearchParams(), mode: "all", deps }), { ok: true, code: "reembedding_planned" });

  const form = new URLSearchParams({ migration: "mig-1" });
  assert.deepEqual(await applyControlUiWriteAction({ action: "reembedding.apply", form, mode: "all", deps }), { ok: true, code: "reembedding_applied" });
  assert.deepEqual(applied, [["apply", "reemb_v1_secret"]], "the stored token is presented by the gateway, not by the browser");
  assert.deepEqual(
    await applyControlUiWriteAction({ action: "reembedding.apply", form: new URLSearchParams({ migration: "other" }), mode: "all", deps }),
    { ok: false, code: "denied_token" },
    "an unknown migration has no confirmation",
  );
});

test("the read-only page renders no form and forbids form posts", async () => {
  const handler = createControlUiHttpHandler({ getProjection: async () => projectionFor() });
  const res = collectingResponse();
  await handler({ method: "GET", url: "/plugins/memory-lancedb-namespaced/control" }, res);
  assert.equal(res.statusCode, 200);
  assert.doesNotMatch(String(res.body), /<form/);
  assert.match(res.getHeader("content-security-policy"), /form-action 'none'/);
  assert.match(String(res.body), /Read-only control tab/);

  const post = collectingResponse();
  await handler(formRequest({ action: "reranker.set", choice: "local-jina" }), post);
  assert.equal(post.statusCode, 405, "a read-only tab does not accept posts at all");
});

test("a write-enabled page renders forms and applies exactly one confirmed action", async () => {
  const applied = [];
  const tokens = createFormTokenStore();
  const handler = createControlUiHttpHandler({
    getProjection: async () => projectionFor(),
    write: {
      mode: "reranker",
      tokens,
      rerankerKeyConfigured: () => false,
      applyAction: async ({ action, form }) => {
        applied.push([action, form.get("choice")]);
        return { ok: true, code: "reranker_switched" };
      },
    },
  });

  const res = collectingResponse();
  await handler({ method: "GET", url: "/plugins/memory-lancedb-namespaced/control" }, res);
  const html = String(res.body);
  assert.match(res.getHeader("content-security-policy"), /form-action 'self'/);
  assert.match(html, /<form class="switch-form" method="post"/);
  assert.match(html, /Switching is enabled on this tab/);
  assert.match(html, /value="local-jina"/);
  assert.match(html, /Needs a key first/, "the hosted option is offered only once a key exists");
  const token = /name="form_token" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(token, "the page carries a form token");

  const post = collectingResponse();
  await handler(formRequest({ [CONTROL_UI_FORM_TOKEN_FIELD]: token, [CONTROL_UI_ACTION_FIELD]: "reranker.set", choice: "local-jina" }), post);
  assert.equal(post.statusCode, 303, "a post answers with a redirect so a reload never repeats it");
  assert.equal(post.getHeader("location"), "/plugins/memory-lancedb-namespaced/control?result=reranker_switched");
  assert.deepEqual(applied, [["reranker.set", "local-jina"]]);

  const replay = collectingResponse();
  await handler(formRequest({ [CONTROL_UI_FORM_TOKEN_FIELD]: token, [CONTROL_UI_ACTION_FIELD]: "reranker.set", choice: "local-jina" }), replay);
  assert.equal(replay.getHeader("location"), "/plugins/memory-lancedb-namespaced/control?result=denied_token");
  assert.equal(applied.length, 1, "a replayed token changes nothing");

  const forged = collectingResponse();
  await handler(formRequest({ [CONTROL_UI_FORM_TOKEN_FIELD]: "x".repeat(43), [CONTROL_UI_ACTION_FIELD]: "reranker.set", choice: "local-jina" }), forged);
  assert.equal(forged.getHeader("location"), "/plugins/memory-lancedb-namespaced/control?result=denied_token");
  assert.equal(applied.length, 1, "a cross-site post without a real token changes nothing");
});

test("the result banner is rendered from a closed set of codes", async () => {
  const handler = createControlUiHttpHandler({
    getProjection: async () => projectionFor(),
    write: { mode: "reranker", tokens: createFormTokenStore(), rerankerKeyConfigured: () => true, applyAction: async () => ({ ok: true, code: "reranker_switched" }) },
  });
  const res = collectingResponse();
  await handler({ method: "GET", url: "/plugins/memory-lancedb-namespaced/control?result=reranker_switched" }, res);
  assert.match(String(res.body), /Reranking switched/);
  const injected = collectingResponse();
  await handler({ method: "GET", url: "/plugins/memory-lancedb-namespaced/control?result=%3Cscript%3E" }, injected);
  assert.doesNotMatch(String(injected.body), /<script>/);
});

test("the descriptor asks for write scope only when the tab can write", () => {
  const registered = [];
  const api = {
    registerGatewayMethod() {},
    registerHttpRoute() {},
    registerControlUiDescriptor(descriptor) { registered.push(descriptor); },
    logger: { warn() {} },
  };
  registerControlUiRuntime({ api, getProjection: async () => projectionFor() });
  assert.deepEqual(registered.at(-1).requiredScopes, ["operator.read"]);

  registerControlUiRuntime({
    api,
    getProjection: async () => projectionFor(),
    write: { mode: "all", tokens: createFormTokenStore(), applyAction: async () => ({ ok: true, code: "reranker_switched" }) },
  });
  assert.deepEqual(registered.at(-1).requiredScopes, ["operator.read", "operator.write"]);
});

test("a writable page carries a nonce-bound submit script and names its own host as connect-src", async () => {
  // OpenClaw's plugin tab is an iframe sandboxed with allow-scripts only, so a
  // native form submission is blocked there. The page therefore posts with
  // fetch; the CSP allows exactly that script and exactly this host.
  const tokens = createFormTokenStore();
  const handler = createControlUiHttpHandler({
    getProjection: async () => projectionFor(),
    write: { mode: "reranker", tokens, rerankerKeyConfigured: () => false, applyAction: async () => ({ ok: true, code: "reranker_switched" }) },
  });
  const res = collectingResponse();
  await handler({ method: "GET", url: "/plugins/memory-lancedb-namespaced/control", headers: { host: "127.0.0.1:18789" } }, res);
  const csp = res.getHeader("content-security-policy");
  const nonce = /script-src 'nonce-([A-Za-z0-9_-]+)'/.exec(csp)?.[1];
  assert.ok(nonce, `CSP must name a script nonce: ${csp}`);
  assert.match(csp, /connect-src http:\/\/127\.0\.0\.1:18789 https:\/\/127\.0\.0\.1:18789;/);
  assert.match(String(res.body), new RegExp(`<script nonce="${nonce}">`));
  assert.match(String(res.body), /mode: "no-cors", credentials: "include"/);
  assert.match(String(res.body), /body\.set\("via", "fetch"\)/);
  // A sandboxed frame never fires the submit event, so the click is what is intercepted.
  assert.match(String(res.body), /button\.addEventListener\("click"/);

  const second = collectingResponse();
  await handler({ method: "GET", url: "/plugins/memory-lancedb-namespaced/control", headers: { host: "127.0.0.1:18789" } }, second);
  assert.notEqual(/nonce-([A-Za-z0-9_-]+)/.exec(second.getHeader("content-security-policy"))[1], nonce, "every page gets a fresh nonce");

  const noHost = collectingResponse();
  await handler({ method: "GET", url: "/plugins/memory-lancedb-namespaced/control", headers: {} }, noHost);
  assert.doesNotMatch(noHost.getHeader("content-security-policy"), /connect-src/, "an unusable Host header yields no connect-src");

  const readOnly = createControlUiHttpHandler({ getProjection: async () => projectionFor() });
  const ro = collectingResponse();
  await readOnly({ method: "GET", url: "/plugins/memory-lancedb-namespaced/control", headers: { host: "127.0.0.1:18789" } }, ro);
  assert.doesNotMatch(ro.getHeader("content-security-policy"), /script-src|connect-src/);
  assert.doesNotMatch(String(ro.body), /<script/);
});

test("a fetch-submitted action answers without a redirect and shows its result exactly once", async () => {
  let clock = 10_000;
  const tokens = createFormTokenStore();
  const handler = createControlUiHttpHandler({
    getProjection: async () => projectionFor(),
    now: () => clock,
    write: { mode: "all", tokens, rerankerKeyConfigured: () => false, applyAction: async () => ({ ok: true, code: "compaction_started" }) },
  });
  const page = collectingResponse();
  await handler({ method: "GET", url: "/plugins/memory-lancedb-namespaced/control", headers: { host: "127.0.0.1:18789" } }, page);
  const token = /name="form_token" value="([^"]+)"/.exec(String(page.body))[1];

  const post = collectingResponse();
  await handler(formRequest({ form_token: token, action: "compaction.start", partition: "main", via: "fetch" }), post);
  assert.equal(post.statusCode, 204);
  assert.equal(post.getHeader("location"), undefined);

  const next = collectingResponse();
  await handler({ method: "GET", url: "/plugins/memory-lancedb-namespaced/control", headers: { host: "127.0.0.1:18789" } }, next);
  assert.match(String(next.body), /Compaction started\./);
  const again = collectingResponse();
  await handler({ method: "GET", url: "/plugins/memory-lancedb-namespaced/control", headers: { host: "127.0.0.1:18789" } }, again);
  assert.doesNotMatch(String(again.body), /Compaction started\./, "the stored result is shown once");

  // A stale token through the fetch path is still refused, and the refusal is what the next page shows.
  const replay = collectingResponse();
  await handler(formRequest({ form_token: token, action: "compaction.start", partition: "main", via: "fetch" }), replay);
  assert.equal(replay.statusCode, 204);
  const afterReplay = collectingResponse();
  await handler({ method: "GET", url: "/plugins/memory-lancedb-namespaced/control", headers: { host: "127.0.0.1:18789" } }, afterReplay);
  assert.match(String(afterReplay.body), /That form was stale/);

  // Results older than the window are dropped rather than shown late.
  const late = collectingResponse();
  const token2 = /name="form_token" value="([^"]+)"/.exec(String(afterReplay.body))[1];
  await handler(formRequest({ form_token: token2, action: "compaction.start", partition: "main", via: "fetch" }), late);
  clock += 120_000;
  const expired = collectingResponse();
  await handler({ method: "GET", url: "/plugins/memory-lancedb-namespaced/control", headers: { host: "127.0.0.1:18789" } }, expired);
  assert.doesNotMatch(String(expired.body), /Compaction started\./);
});
