import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  REEMBEDDING_GATEWAY_METHODS,
  createReembeddingGatewayHandlers,
  executeReembeddingCli,
  readJsonPlanRequest,
  registerReembeddingRuntime,
} from "../lib/setup/reembedding-plugin-runtime.js";

function captureResponse() {
  const calls = [];
  return { calls, respond: (...args) => calls.push(args) };
}

function fakeProgram() {
  const command = {
    description() { return this; },
    argument() { return this; },
    option() { return this; },
    action(handler) { this.handler = handler; return this; },
  };
  return { command: (name) => { command.name = name; return command; }, definition: command };
}

describe("reembedding OpenClaw operator runtime", () => {
  it("registers closed read/admin RPC scopes, one typed action, and a thin CLI", () => {
    const gateway = [];
    const actions = [];
    const clis = [];
    registerReembeddingRuntime({
      api: {
        registerGatewayMethod(name, handler, options) { gateway.push({ name, handler, options }); },
        registerCli(registrar, options) { clis.push({ registrar, options }); },
        session: { controls: { registerSessionAction(action) { actions.push(action); } } },
      },
      coordinator: { status: async () => null, plan: async () => ({}), apply: async () => ({}), resume: async () => ({}), validate: async () => ({}) },
      switchRuntime: { switchGeneration: async () => ({}), planManualRollback: async () => ({}) },
      readConfirmationToken: async () => "token-from-stdin",
    });
    assert.deepStrictEqual(gateway.map(({ name, options }) => [name, options.scope]), [
      [REEMBEDDING_GATEWAY_METHODS.status, "operator.read"],
      [REEMBEDDING_GATEWAY_METHODS.plan, "operator.admin"],
      [REEMBEDDING_GATEWAY_METHODS.apply, "operator.admin"],
      [REEMBEDDING_GATEWAY_METHODS.resume, "operator.admin"],
      [REEMBEDDING_GATEWAY_METHODS.switch, "operator.admin"],
      [REEMBEDDING_GATEWAY_METHODS.rollback, "operator.admin"],
    ]);
    assert.equal(actions.length, 1);
    assert.deepStrictEqual(actions[0].requiredScopes, ["operator.admin"]);
    assert.equal(actions[0].schema.additionalProperties, false);
    assert.equal(clis.length, 1);
    assert.equal(clis[0].options.descriptors[0].name, "plur1bus-reembedding");
  });

  it("automatically validates a completed apply/resume before reporting success", async () => {
    const calls = [];
    const coordinator = {
      status: async () => null,
      plan: async () => ({}),
      apply: async (request) => { calls.push(["apply", request]); return { id: request.id, state: "validating" }; },
      resume: async (request) => { calls.push(["resume", request]); return { id: request.id, state: "validating" }; },
      validate: async (request) => { calls.push(["validate", request]); return { id: request.id, state: "ready_to_switch" }; },
    };
    const handlers = createReembeddingGatewayHandlers({
      coordinator,
      switchRuntime: { switchGeneration: async () => ({}), planManualRollback: async () => ({}) },
    });
    for (const operation of ["apply", "resume"]) {
      const response = captureResponse();
      await handlers[operation]({
        params: { id: "migration-1", token: "confirmation-token" },
        respond: response.respond,
      });
      assert.equal(response.calls[0][0], true);
      assert.equal(response.calls[0][1].migration.state, "ready_to_switch");
    }
    assert.deepStrictEqual(calls.map(([name]) => name), ["apply", "validate", "resume", "validate"]);
  });

  it("rejects credential material and unknown request fields before coordinator access", async () => {
    let plans = 0;
    const handlers = createReembeddingGatewayHandlers({
      coordinator: {
        status: async () => null,
        plan: async () => { plans += 1; return {}; },
        apply: async () => ({}), resume: async () => ({}), validate: async () => ({}),
      },
      switchRuntime: { switchGeneration: async () => ({}), planManualRollback: async () => ({}) },
    });
    for (const params of [
      { id: "migration-1", target: { apiKey: "must-not-pass" } },
      { id: "migration-1", target: { fingerprint: {} }, unexpected: true },
    ]) {
      const response = captureResponse();
      await handlers.plan({ params, respond: response.respond });
      assert.equal(response.calls[0][0], false);
      assert.doesNotMatch(JSON.stringify(response.calls), /must-not-pass/);
    }
    assert.equal(plans, 0);
  });

  it("reads confirmation tokens outside process arguments and makes one Gateway call", async () => {
    const calls = [];
    let tokenReads = 0;
    await executeReembeddingCli({
      operation: "switch",
      id: "migration-1",
      callGateway: async (...args) => { calls.push(args); return { migration: { state: "completed" } }; },
      readConfirmationToken: async () => { tokenReads += 1; return "stdin-token"; },
      write() {},
    });
    assert.equal(tokenReads, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], REEMBEDDING_GATEWAY_METHODS.switch);
    assert.deepStrictEqual(calls[0][2], { id: "migration-1", token: "stdin-token" });
  });

  it("reads a bounded plan document from stdin without accepting trailing JSON", async () => {
    const input = async function* () {
      yield '{"id":"migration-1","target":{"fingerprint":{"provider":"openai","model":"m","dimensions":3}}}';
    };
    assert.deepStrictEqual(await readJsonPlanRequest({ input: input() }), {
      id: "migration-1",
      target: { fingerprint: { provider: "openai", model: "m", dimensions: 3 } },
    });
    const trailing = async function* () { yield "{}{}"; };
    await assert.rejects(readJsonPlanRequest({ input: trailing() }), /valid JSON/);
  });
});
