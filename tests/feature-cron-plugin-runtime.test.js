import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import {
  FEATURE_CRON_GATEWAY_METHOD,
  createFeatureCronGatewayHandler,
  executeFeatureCronCli,
  loadOpenClawGatewayRuntime,
  parseFeatureCronRunnerArgs,
  registerFeatureCronNativeDispatch,
  PLUGIN_COMMAND_GATEWAY_METHOD,
  PLUGIN_COMMAND_CLI_COMMAND,
  validatePluginCommandRequest,
  executePluginCommandCli,
  validateFeatureCronRequest,
} from "../lib/setup/feature-cron-plugin-runtime.js";
import { runFeatureCronRunner } from "../scripts/run-feature-cron.mjs";

const require = createRequire(import.meta.url);

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

  // Operator-Pfad: die Chat-Kommandos waren nur ueber einen angebundenen Kanal
  // erreichbar. Mit runOperatorCommand registriert das Modul zusaetzlich den
  // RPC plur1bus.command.run und das CLI plur1bus-command — ohne bleibt alles
  // wie bisher (der Test darunter zaehlt dann weiterhin genau einen RPC).
  it("registers the operator command RPC and CLI only when a runner is supplied", () => {
    const gateway = [];
    const clis = [];
    registerFeatureCronNativeDispatch({
      api: {
        registerGatewayMethod(method, handler, options) { gateway.push({ method, handler, options }); },
        registerCli(registrar, options) { clis.push({ registrar, options }); },
      },
      runFeatureCommand: async () => ({ text: "NO_REPLY" }),
      runOperatorCommand: async () => ({ text: "ok" }),
    });
    const methods = gateway.map((g) => g.method);
    assert.ok(methods.includes(PLUGIN_COMMAND_GATEWAY_METHOD));
    assert.equal(gateway.find((g) => g.method === PLUGIN_COMMAND_GATEWAY_METHOD).options.scope, "operator.write");
    assert.ok(clis.some((c) => c.options.descriptors[0].name === PLUGIN_COMMAND_CLI_COMMAND));
  });

  it("validates the operator command request strictly", () => {
    const ok = validatePluginCommandRequest({ agentId: "main", sessionKey: "agent:main:telegram:default:direct:1", command: " /memory heute " });
    assert.deepStrictEqual(ok, { agentId: "main", sessionKey: "agent:main:telegram:default:direct:1", command: "/memory heute" });
    assert.throws(() => validatePluginCommandRequest({ agentId: "main", sessionKey: "s", command: "memory" }), /invalid PLUR1BUS command/);
    assert.throws(() => validatePluginCommandRequest({ agentId: "main", command: "/x" }), /fields/);
    assert.throws(() => validatePluginCommandRequest({ agentId: "main", sessionKey: "s", command: "/x", extra: 1 }), /fields/);
    // 7.12.24: optionales locale, streng validiert
    assert.deepStrictEqual(
      validatePluginCommandRequest({ agentId: "main", sessionKey: "s", command: "/x", locale: " de " }),
      { agentId: "main", sessionKey: "s", command: "/x", locale: "de" },
    );
    assert.equal(Object.hasOwn(validatePluginCommandRequest({ agentId: "main", sessionKey: "s", command: "/x" }), "locale"), false);
    assert.throws(() => validatePluginCommandRequest({ agentId: "main", sessionKey: "s", command: "/x", locale: "deutsch" }), /locale/);
    assert.throws(() => validatePluginCommandRequest({ agentId: "main", sessionKey: "s", command: "/x", locale: "" }), /locale/);
    assert.throws(() => validatePluginCommandRequest({ agentId: "main", sessionKey: "", command: "/x" }), /session/);
  });

  it("runs the operator command through exactly one RPC call and prints only the text", async () => {
    const calls = [];
    let output = "";
    const reply = await executePluginCommandCli({
      agentId: "main",
      sessionKey: "agent:main:telegram:default:direct:55736530",
      command: "/plur1bus_status",
      callGateway: async (...args) => { calls.push(args); return { reply: { text: "Status: ok" } }; },
      write: (chunk) => { output += chunk; },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], PLUGIN_COMMAND_GATEWAY_METHOD);
    assert.deepStrictEqual(calls[0][2], { agentId: "main", sessionKey: "agent:main:telegram:default:direct:55736530", command: "/plur1bus_status" });
    assert.deepStrictEqual(calls[0][3], { progress: false, scopes: ["operator.write"] });
    assert.deepStrictEqual(reply, { text: "Status: ok" });
    assert.equal(output, "Status: ok\n");
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

  // Ohne workspaceDir uebersprang afterthought sich bei jedem Cron-Lauf still
  // ("missing_workspace", Cron meldete ok) und persona-evolve warf
  // "The path argument must be of type string. Received undefined".
  it("accepts the model-free auto-accept-stale job and still rejects unknown names", async () => {
    const seen = [];
    const capture = responseCapture();
    const handler = createFeatureCronGatewayHandler({
      runFeatureCommand: async (ctx) => { seen.push(ctx); return { text: "done" }; },
      config: {},
    });
    await handler({ params: { agentId: "main", feature: "auto-accept-stale" }, respond: capture.respond });
    assert.equal(seen[0].args, "internal auto-accept-stale");
    const drain = responseCapture();
    await handler({ params: { agentId: "main", feature: "embedding-drain" }, respond: drain.respond });
    assert.equal(seen[1].args, "internal embedding-drain");
    assert.deepStrictEqual(capture.calls, [[true, { reply: { text: "done" } }]]);

    for (const feature of ["reminder-dispatch", "feedback-report", "proactive-check", "meta-reflect"]) {
      const extra = responseCapture();
      const before = seen.length;
      await handler({ params: { agentId: "main", feature }, respond: extra.respond });
      assert.equal(seen[before].args, `internal ${feature}`, feature);
      assert.equal(extra.calls[0][0], true, feature);
    }

    const rejected = responseCapture();
    await handler({ params: { agentId: "main", feature: "definitely-not-a-feature" }, respond: rejected.respond });
    assert.equal(rejected.calls[0][0], false);
  });

  it("resolves the agent workspace and hands it to the command", async () => {
    const seen = [];
    const capture = responseCapture();
    const asked = [];
    const handler = createFeatureCronGatewayHandler({
      runFeatureCommand: async (ctx) => { seen.push(ctx); return { text: "done" }; },
      config: { lab: true },
      resolveWorkspaceDir: async (cfg, agentId) => { asked.push([cfg, agentId]); return "/root/.openclaw/workspace-bernhardine"; },
    });
    await handler({ params: { agentId: "bernhardine", feature: "afterthought" }, respond: capture.respond });
    assert.deepStrictEqual(asked, [[{ lab: true }, "bernhardine"]]);
    assert.equal(seen[0].workspaceDir, "/root/.openclaw/workspace-bernhardine");
    assert.deepStrictEqual(capture.calls, [[true, { reply: { text: "done" } }]]);
  });

  it("runs on and says so when the workspace cannot be resolved", async () => {
    for (const resolver of [
      async () => { throw new Error("runtime unavailable"); },
      async () => undefined,
      async () => "",
    ]) {
      const seen = [];
      const warnings = [];
      const capture = responseCapture();
      const handler = createFeatureCronGatewayHandler({
        runFeatureCommand: async (ctx) => { seen.push(ctx); return { text: "done" }; },
        config: { lab: true },
        logger: { warn: (message) => warnings.push(message) },
        resolveWorkspaceDir: resolver,
      });
      await handler({ params: { agentId: "agent-a", feature: "gc-run" }, respond: capture.respond });
      assert.equal("workspaceDir" in seen[0], false, "no empty workspaceDir is passed on");
      assert.ok(warnings.some((message) => message.includes("without a workspace dir")), "the skip must be visible in the log");
      assert.deepStrictEqual(capture.calls, [[true, { reply: { text: "done" } }]]);
    }
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

  it("loads the exact installed OpenClaw target's public Gateway runtime", async () => {
    const packageManifestPath = join(dirname(dirname(require.resolve("openclaw"))), "package.json");
    const manifest = require(packageManifestPath);
    assert.equal(manifest.version, "2026.8.2");
    const runtime = await loadOpenClawGatewayRuntime({ packageManifestPath });
    assert.equal(typeof runtime.callGatewayFromCli, "function");
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
