import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  WORKSPACE_POLICY_GATEWAY_METHODS,
  createWorkspacePolicyGatewayHandlers,
  executeWorkspacePolicyCli,
  registerWorkspacePolicyRuntime,
  validateWorkspacePolicyGetRequest,
  validateWorkspacePolicySetRequest,
} from "../lib/setup/workspace-policy-plugin-runtime.js";

async function loadFreshPlugin() {
  return import(`../index.js?workspace-policy-beta1=${Date.now()}-${Math.random()}`);
}

function captureResponse() {
  const calls = [];
  return { calls, respond: (...args) => calls.push(args) };
}

function fakeProgram() {
  const command = {
    description() { return this; },
    argument() { return this; },
    requiredOption() { return this; },
    option() { return this; },
    action(handler) { this.handler = handler; return this; },
  };
  return { command: (name) => { command.name = name; return command; }, definition: command };
}

describe("workspace policy OpenClaw runtime", () => {
  it("accepts only session-bound read and mutation request shapes", () => {
    assert.deepStrictEqual(validateWorkspacePolicyGetRequest({ sessionKey: "agent:a:main" }), {
      sessionKey: "agent:a:main",
    });
    assert.deepStrictEqual(validateWorkspacePolicySetRequest({
      sessionKey: "agent:a:main",
      enabled: false,
      expectedRevision: 3,
    }), {
      sessionKey: "agent:a:main",
      enabled: false,
      expectedRevision: 3,
    });
    for (const value of [
      { sessionKey: "agent:a:main", workspacePath: "/tmp/a" },
      { sessionKey: "agent:a:main", owner: "user" },
      { sessionKey: "agent:a:main", enabled: false, expectedRevision: -1 },
      { sessionKey: "agent:a:main", enabled: "false", expectedRevision: 0 },
    ]) {
      assert.throws(
        () => Object.hasOwn(value, "enabled")
          ? validateWorkspacePolicySetRequest(value)
          : validateWorkspacePolicyGetRequest(value),
        /workspace policy request/i,
      );
    }
  });

  it("resolves session identity before reads and writes", async () => {
    const resolved = [];
    const mutations = [];
    const memoryCtx = { agentId: "agent-a", workspaceIdentity: "workspace:v1:alpha" };
    const handlers = createWorkspacePolicyGatewayHandlers({
      store: { list: () => [] },
      guard: {
        decision: (ctx) => ({ allowed: true, policy: { ...ctx, enabled: true, revision: 0 } }),
        set: async (input) => { mutations.push(input); return { ...input.memoryCtx, enabled: input.enabled, revision: 1 }; },
      },
      resolveSessionMemoryContext: async (input) => { resolved.push(input); return memoryCtx; },
    });

    const getCapture = captureResponse();
    await handlers.get({ params: { sessionKey: "agent:agent-a:main" }, respond: getCapture.respond });
    assert.deepStrictEqual(getCapture.calls, [[true, {
      policy: { ...memoryCtx, enabled: true, revision: 0 },
    }]]);

    const setCapture = captureResponse();
    await handlers.set({
      params: { sessionKey: "agent:agent-a:main", enabled: false, expectedRevision: 0 },
      client: { connId: "conn-1" },
      respond: setCapture.respond,
    });
    assert.deepStrictEqual(resolved, [
      { sessionKey: "agent:agent-a:main" },
      { sessionKey: "agent:agent-a:main" },
    ]);
    assert.equal(Object.hasOwn(mutations[0], "workspacePath"), false);
    assert.equal(mutations[0].actorId, "operator:conn-1");
    assert.deepStrictEqual(setCapture.calls, [[true, {
      policy: { ...memoryCtx, enabled: false, revision: 1 },
    }]]);
  });

  it("registers three correctly scoped RPCs, one typed action, and one CLI", () => {
    const gateway = [];
    const actions = [];
    const clis = [];
    registerWorkspacePolicyRuntime({
      api: {
        registerGatewayMethod(name, handler, options) { gateway.push({ name, handler, options }); },
        registerCli(registrar, options) { clis.push({ registrar, options }); },
        session: { controls: { registerSessionAction(action) { actions.push(action); } } },
      },
      store: { list: () => [] },
      guard: { decision: () => ({ policy: {} }), set: async () => ({}) },
      resolveSessionMemoryContext: async () => ({ agentId: "a", workspaceIdentity: "workspace:v1:a" }),
    });
    assert.deepStrictEqual(gateway.map(({ name, options }) => [name, options.scope]), [
      [WORKSPACE_POLICY_GATEWAY_METHODS.get, "operator.read"],
      [WORKSPACE_POLICY_GATEWAY_METHODS.list, "operator.read"],
      [WORKSPACE_POLICY_GATEWAY_METHODS.set, "operator.write"],
    ]);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].id, "workspace-policy.set");
    assert.deepStrictEqual(actions[0].requiredScopes, ["operator.write"]);
    assert.equal(actions[0].schema.additionalProperties, false);
    assert.equal(clis.length, 1);
    assert.equal(clis[0].options.descriptors[0].name, "plur1bus-workspace");
  });

  it("executes the typed session mutation without owner or raw path input", async () => {
    const actions = [];
    const seen = [];
    registerWorkspacePolicyRuntime({
      api: {
        registerGatewayMethod() {},
        registerCli() {},
        session: { controls: { registerSessionAction(action) { actions.push(action); } } },
      },
      store: { list: () => [] },
      guard: {
        decision: () => ({ policy: {} }),
        set: async (input) => { seen.push(input); return { enabled: input.enabled, revision: 2 }; },
      },
      resolveSessionMemoryContext: async ({ sessionKey, agentId }) => ({
        agentId,
        workspaceIdentity: `workspace:v1:${sessionKey}`,
      }),
    });
    const result = await actions[0].handler({
      sessionKey: "session-a",
      agentId: "agent-a",
      payload: { enabled: false, expectedRevision: 1 },
      client: { connId: "conn-a", scopes: ["operator.write"] },
    });
    assert.deepStrictEqual(result, { result: { policy: { enabled: false, revision: 2 } } });
    assert.equal(seen[0].actorId, "operator:conn-a");
    assert.equal(Object.hasOwn(seen[0], "owner"), false);
  });

  it("uses one Gateway request for CLI status and mutations", async () => {
    const calls = [];
    const callGateway = async (...args) => { calls.push(args); return { policy: { enabled: true, revision: 4 } }; };
    let output = "";
    await executeWorkspacePolicyCli({ operation: "status", sessionKey: "s", callGateway, write: (text) => { output += text; } });
    await executeWorkspacePolicyCli({ operation: "disable", sessionKey: "s", expectedRevision: 4, callGateway, write() {} });
    assert.deepStrictEqual(calls.map(([name]) => name), [
      WORKSPACE_POLICY_GATEWAY_METHODS.get,
      WORKSPACE_POLICY_GATEWAY_METHODS.set,
    ]);
    assert.match(output, /"enabled": true/);
  });

  it("plugin-registered Gateway policy handlers resolve Beta1 spawnedCwd sessions", async (t) => {
    const baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-policy-beta1-state-"));
    const spawnedCwd = realpathSync(mkdtempSync(join(tmpdir(), "plur1bus-policy-beta1-cwd-")));
    const fallbackWorkspace = realpathSync(mkdtempSync(join(tmpdir(), "plur1bus-policy-beta1-fallback-")));
    t.after(() => {
      rmSync(baseDbPath, { recursive: true, force: true });
      rmSync(spawnedCwd, { recursive: true, force: true });
      rmSync(fallbackWorkspace, { recursive: true, force: true });
    });
    const agentId = "beta1-agent";
    const sessionKey = `agent:${agentId}:main`;
    const gateway = new Map();
    const pluginModule = await loadFreshPlugin();
    pluginModule.default.register({
      pluginConfig: {
        baseDbPath,
        autoCapture: false,
        autoRecall: false,
        neo: { enabled: false },
        obsidianBridge: { enabled: false },
        featureCronSetup: { auto: false },
        gc: { enabled: false },
        embedding: { provider: "local-transformers", local: { dimensions: 384 } },
      },
      config: {},
      logger: { debug() {}, error() {}, info() {}, warn() {} },
      runtime: {
        agent: {
          resolveAgentWorkspaceDir: async () => fallbackWorkspace,
          session: {
            getSessionEntry: () => ({ spawnedCwd }),
          },
        },
      },
      resolvePath: (value) => value,
      registerCommand() {},
      registerTool() {},
      registerService() {},
      registerGatewayMethod(name, handler) { gateway.set(name, handler); },
      registerCli() {},
      session: { controls: { registerSessionAction() {} } },
      on() {},
    }, {
      importRouting: async () => ({
        parseAgentSessionKey(value) {
          const match = /^agent:([^:]+):(.+)$/.exec(value);
          return match ? { agentId: match[1], rest: match[2] } : null;
        },
        parseThreadSessionSuffix(value) {
          return { baseSessionKey: value, threadId: "" };
        },
        normalizeOptionalAccountId(value) {
          return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
        },
        normalizeMessageChannel(value) {
          return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
        },
      }),
    });

    const getResponses = [];
    await gateway.get(WORKSPACE_POLICY_GATEWAY_METHODS.get)({
      params: { sessionKey },
      respond: (...args) => getResponses.push(args),
    });
    const expectedWorkspaceIdentity = `workspace-dir:v1:${spawnedCwd}`;
    assert.deepStrictEqual(getResponses, [[true, {
      policy: {
        agentId,
        workspaceIdentity: expectedWorkspaceIdentity,
        enabled: true,
        revision: 0,
        source: "default",
      },
    }]]);

    const setResponses = [];
    await gateway.get(WORKSPACE_POLICY_GATEWAY_METHODS.set)({
      params: { sessionKey, enabled: false, expectedRevision: 0 },
      client: { connId: "beta1-test" },
      respond: (...args) => setResponses.push(args),
    });
    assert.equal(setResponses[0][0], true);
    assert.equal(setResponses[0][1].policy.agentId, agentId);
    assert.equal(setResponses[0][1].policy.workspaceIdentity, expectedWorkspaceIdentity);
    assert.equal(setResponses[0][1].policy.enabled, false);
    assert.equal(setResponses[0][1].policy.source, "override");
  });
});
