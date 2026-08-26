import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  FEATURE_CRON_GATEWAY_METHOD,
  createFeatureCronGatewayHandler,
  executeFeatureCronCli,
  loadOpenClawGatewayRuntime,
  parseFeatureCronRunnerArgs,
  registerFeatureCronNativeDispatch,
  validateFeatureCronRequest,
} from "../lib/setup/feature-cron-plugin-runtime.js";
import { runFeatureCronRunner } from "../scripts/run-feature-cron.mjs";

function responseCapture() {
  const calls = [];
  return {
    calls,
    respond(...args) { calls.push(args); },
  };
}

function fakeProgram() {
  const command = {
    description() { return this; },
    requiredOption() { return this; },
    action(handler) { this.handler = handler; return this; },
  };
  return {
    command(name) { command.name = name; return command; },
    commandDefinition: command,
  };
}

describe("PLUR1BUS feature-cron plugin runtime", () => {
  it("parses only the exact runner CLI shape without accepting carrier commands", () => {
    assert.deepStrictEqual(
      parseFeatureCronRunnerArgs(["--agent", "agent-a", "--feature", "afterthought"]),
      { agentId: "agent-a", feature: "afterthought" },
    );
    for (const argv of [
      ["--agent", "agent-a"],
      ["--feature", "afterthought"],
      ["--agent", "agent-a", "--feature", "afterthought", "--message", "/custom"],
      ["--agent", "agent-a", "--agent", "agent-b", "--feature", "afterthought"],
    ]) {
      assert.throws(() => parseFeatureCronRunnerArgs(argv), /runner arguments/i);
    }
  });

  it("accepts only the exact shipped features and safe agent ids", () => {
    assert.deepStrictEqual(validateFeatureCronRequest({ agentId: "agent-a", feature: "gc-run" }), {
      agentId: "agent-a",
      feature: "gc-run",
    });
    for (const params of [
      { agentId: "../prod", feature: "gc-run" },
      { agentId: "agent-a", feature: "custom" },
      { agentId: "agent-a", feature: "gc-run", command: "/custom" },
      null,
    ]) {
      assert.throws(() => validateFeatureCronRequest(params), /feature cron request|agent|unknown/i);
    }
  });

  it("registers one write-scoped RPC and one lazy root CLI capability", () => {
    const gateway = [];
    const clis = [];
    registerFeatureCronNativeDispatch({
      api: {
        registerGatewayMethod(method, handler, options) { gateway.push({ method, handler, options }); },
        registerCli(registrar, options) { clis.push({ registrar, options }); },
      },
      runFeatureCommand: async () => ({ text: "NO_REPLY" }),
    });
    assert.equal(gateway.length, 1);
    assert.equal(gateway[0].method, FEATURE_CRON_GATEWAY_METHOD);
    assert.deepStrictEqual(gateway[0].options, { scope: "operator.write" });
    assert.equal(clis.length, 1);
    assert.deepStrictEqual(clis[0].options.descriptors.map(({ machineOutput, ...descriptor }) => descriptor), [{
      name: "plur1bus-feature-cron",
      description: "Run one PLUR1BUS feature cron without an agent/model turn",
      hasSubcommands: false,
    }]);
    assert.equal(clis[0].options.descriptors[0].machineOutput({ argv: [], stdoutIsTTY: false }), true);
  });

  it("runs the exact internal command in a cron-isolated agent context", async () => {
    const seen = [];
    const capture = responseCapture();
    const handler = createFeatureCronGatewayHandler({
      runFeatureCommand: async (ctx) => { seen.push(ctx); return { text: "done" }; },
      config: { lab: true },
    });
    await handler({ params: { agentId: "agent-a", feature: "gc-run" }, respond: capture.respond });
    assert.equal(seen.length, 1);
    assert.deepStrictEqual(seen[0], {
      args: "internal gc-run",
      agentId: "agent-a",
      channel: "cron",
      origin: "cron",
      source: "cron",
      sessionKey: "agent:agent-a:cron:plur1bus-gc-run",
      config: { lab: true },
    });
    assert.deepStrictEqual(capture.calls, [[true, { reply: { text: "done" } }]]);
  });

  it("preserves ReplyPayload and literal NO_REPLY through exactly one RPC call", async () => {
    for (const text of ["deliver this", "NO_REPLY"]) {
      const calls = [];
      let output = "";
      const result = await executeFeatureCronCli({
        agentId: "agent-a",
        feature: "afterthought",
        callGateway: async (...args) => {
          calls.push(args);
          return { reply: { text } };
        },
        write: (chunk) => { output += chunk; },
      });
      assert.deepStrictEqual(result, { text });
      assert.equal(output, `${text}\n`);
      assert.equal(calls.length, 1);
      assert.deepStrictEqual(calls[0], [
        FEATURE_CRON_GATEWAY_METHOD,
        { timeout: "540000", json: true },
        { agentId: "agent-a", feature: "afterthought" },
        { progress: false, scopes: ["operator.write"] },
      ]);
    }
  });

  it("runs through the package runner without loading the OpenClaw plugin CLI", async () => {
    const calls = [];
    let output = "";
    const reply = await runFeatureCronRunner(
      ["--agent", "agent-a", "--feature", "afterthought"],
      {
        loadGatewayRuntime: async () => ({
          callGatewayFromCli: async (...args) => {
            calls.push(args);
            return { reply: { text: "NO_REPLY" } };
          },
        }),
        write: (chunk) => { output += chunk; },
      },
    );
    assert.deepStrictEqual(reply, { text: "NO_REPLY" });
    assert.equal(output, "NO_REPLY\n");
    assert.equal(calls.length, 1);
  });

  it("resolves the active public OpenClaw runtime from PATH in a standalone cron runner", async () => {
    const root = mkdtempSync(join(tmpdir(), "plur1bus-openclaw-runtime-"));
    try {
      const packageRoot = join(root, "openclaw");
      const packageBin = join(packageRoot, "bin");
      const packageDist = join(packageRoot, "dist");
      const pathBin = join(root, "path-bin");
      mkdirSync(packageBin, { recursive: true });
      mkdirSync(packageDist, { recursive: true });
      mkdirSync(pathBin, { recursive: true });
      writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
        name: "openclaw",
        type: "module",
        exports: {
          "./plugin-sdk/gateway-runtime": "./dist/gateway-runtime.js",
        },
      }));
      writeFileSync(
        join(packageBin, "openclaw.js"),
        "#!/usr/bin/env node\n",
        { mode: 0o755 },
      );
      writeFileSync(
        join(packageDist, "gateway-runtime.js"),
        "export const runtimeSentinel = 'resolved-from-path';\n",
      );
      symlinkSync(join(packageBin, "openclaw.js"), join(pathBin, "openclaw"));

      const runtime = await loadOpenClawGatewayRuntime({
        entryPath: new URL("../scripts/run-feature-cron.mjs", import.meta.url).pathname,
        pathValue: pathBin,
      });
      assert.equal(runtime.runtimeSentinel, "resolved-from-path");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails visibly for plugin errors and malformed ReplyPayloads", async () => {
    const capture = responseCapture();
    const handler = createFeatureCronGatewayHandler({
      runFeatureCommand: async () => { throw new Error("plugin handler sentinel"); },
      config: {},
    });
    await handler({ params: { agentId: "agent-a", feature: "gc-run" }, respond: capture.respond });
    assert.equal(capture.calls.length, 1);
    assert.equal(capture.calls[0][0], false);
    assert.match(capture.calls[0][2].message, /plugin handler sentinel/);

    await assert.rejects(
      executeFeatureCronCli({
        agentId: "agent-a",
        feature: "gc-run",
        callGateway: async () => ({ reply: null }),
        write() {},
      }),
      /ReplyPayload/i,
    );
  });

  it("wires the CLI action to the injected gateway capability without a fallback execution", async () => {
    const gateway = [];
    const clis = [];
    let output = "";
    registerFeatureCronNativeDispatch({
      api: {
        registerGatewayMethod(method, handler, options) { gateway.push({ method, handler, options }); },
        registerCli(registrar, options) { clis.push({ registrar, options }); },
      },
      runFeatureCommand: async () => ({ text: "ignored in CLI process" }),
      loadGatewayRuntime: async () => ({
        callGatewayFromCli: async () => ({ reply: { text: "NO_REPLY" } }),
      }),
      write: (chunk) => { output += chunk; },
    });
    const program = fakeProgram();
    await clis[0].registrar({ program, config: {} });
    assert.equal(program.commandDefinition.name, "plur1bus-feature-cron");
    await program.commandDefinition.handler({ agent: "agent-a", feature: "afterthought" });
    assert.equal(output, "NO_REPLY\n");
    assert.equal(gateway.length, 1);
  });

  it("fails closed when either required Beta capability is absent", () => {
    assert.throws(
      () => registerFeatureCronNativeDispatch({
        api: { registerCli() {} },
        runFeatureCommand: async () => ({ text: "NO_REPLY" }),
      }),
      /registerGatewayMethod/i,
    );
    assert.throws(
      () => registerFeatureCronNativeDispatch({
        api: { registerGatewayMethod() {} },
        runFeatureCommand: async () => ({ text: "NO_REPLY" }),
      }),
      /registerCli/i,
    );
  });
});
