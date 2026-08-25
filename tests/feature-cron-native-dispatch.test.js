import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildNativeFeatureCommandArgv,
  isNativeFeatureCommandPayload,
  planNativeFeaturePayloadMigration,
} from "../lib/setup/feature-cron-native.js";
import {
  buildAddArgs,
  buildEditArgs,
  probeNativeCronCommandDispatch,
  runSetupFeatureCrons,
} from "../scripts/setup-feature-crons.mjs";
import { planUnsafeDirectCronDisables } from "../lib/setup/feature-cron-plan.js";

function nativeJob(overrides = {}) {
  return {
    name: "plur1bus afterthought main",
    feature: "afterthought",
    command: "/plur1bus internal afterthought",
    message: "/plur1bus internal afterthought",
    schedule: { kind: "every", everyMs: 10_800_000 },
    needsDelivery: true,
    enabled: true,
    agent: "main",
    delivery: { channel: "telegram", to: "123", accountId: "lab" },
    ...overrides,
  };
}

function captureStream() {
  let text = "";
  return {
    stream: { write(chunk) { text += String(chunk); } },
    read() { return text; },
  };
}

describe("native OpenClaw feature-cron dispatch", () => {
  it("builds an exact agent-isolated Gateway command without an outer model carrier", () => {
    assert.deepStrictEqual(
      buildNativeFeatureCommandArgv({
        agentId: "main",
        feature: "afterthought",
        command: "/plur1bus internal afterthought",
      }),
      [
        "openclaw",
        "agent",
        "--agent",
        "main",
        "--session-key",
        "agent:main:cron:plur1bus-afterthought",
        "--channel",
        "cron",
        "--message",
        "/plur1bus internal afterthought",
        "--timeout",
        "540",
      ],
    );
  });

  it("creates a native command payload with exactly one delivery owner", () => {
    const args = buildAddArgs(nativeJob(), { dispatchMode: "native-command" });
    const commandIndex = args.indexOf("--command-argv");
    const argv = JSON.parse(args[commandIndex + 1]);

    assert.ok(commandIndex > -1);
    assert.equal(args.includes("--message"), false);
    assert.equal(args.filter((arg) => arg === "--announce").length, 1);
    assert.equal(argv.includes("--deliver"), false);
    assert.equal(argv.includes("--local"), false);
    assert.equal(argv[argv.indexOf("--channel") + 1], "cron");
    assert.equal(argv[argv.indexOf("--session-key") + 1], "agent:main:cron:plur1bus-afterthought");
    assert.deepStrictEqual(args.slice(commandIndex + 2, commandIndex + 6), [
      "--timeout-seconds",
      "600",
      "--output-max-bytes",
      "65536",
    ]);
  });

  it("keeps ReplyPayload text and NO_REPLY untouched on the native stdout boundary", () => {
    for (const text of ["kritische Nachricht", "NO_REPLY"]) {
      const argv = buildNativeFeatureCommandArgv({
        agentId: "main",
        feature: "classify-recent",
        command: "/plur1bus internal classify-recent",
      });
      assert.equal(argv[argv.indexOf("--message") + 1], "/plur1bus internal classify-recent");
      assert.equal(text.trim(), text);
    }
  });

  it("recognizes only exact shipped native payloads and rejects foreign cron commands", () => {
    const argv = buildNativeFeatureCommandArgv({
      agentId: "ops",
      feature: "classify-recent",
      command: "/plur1bus internal classify-recent",
    });
    assert.equal(isNativeFeatureCommandPayload({ kind: "command", argv }, {
      agentId: "ops",
      feature: "classify-recent",
      command: "/plur1bus internal classify-recent",
    }), true);
    assert.equal(isNativeFeatureCommandPayload({ kind: "command", argv: ["openclaw", "agent", "--agent", "ops", "--message", "/custom"] }, {
      agentId: "ops",
      feature: "classify-recent",
      command: "/plur1bus internal classify-recent",
    }), false);
  });

  it("plans one idempotent agentTurn-to-command migration and no second execution path", () => {
    const existing = {
      id: "job-1",
      name: "plur1bus afterthought main",
      agentId: "main",
      payload: { kind: "agentTurn", message: "/plur1bus internal afterthought" },
    };
    const spec = nativeJob();
    const migration = planNativeFeaturePayloadMigration(existing, spec);

    assert.deepStrictEqual(migration, {
      id: "job-1",
      name: "plur1bus afterthought main",
      commandArgv: buildNativeFeatureCommandArgv({
        agentId: "main",
        feature: "afterthought",
        command: "/plur1bus internal afterthought",
      }),
    });
    const editArgs = buildEditArgs(migration);
    assert.equal(editArgs.includes("--message"), false);
    assert.equal(editArgs.filter((arg) => arg === "--command-argv").length, 1);
    assert.equal(
      planNativeFeaturePayloadMigration(
        { ...existing, payload: { kind: "command", argv: migration.commandArgv } },
        spec,
      ),
      null,
    );
  });

  it("keeps native direct jobs fail-closed when neither compatibility path is ready", () => {
    const argv = buildNativeFeatureCommandArgv({
      agentId: "main",
      feature: "afterthought",
      command: "/plur1bus internal afterthought",
    });
    assert.deepStrictEqual(planUnsafeDirectCronDisables([{
      id: "native-afterthought",
      name: "plur1bus afterthought main",
      agentId: "main",
      enabled: true,
      payload: { kind: "command", argv },
    }]), [{
      id: "native-afterthought",
      name: "plur1bus afterthought main",
      safetyName: "plur1bus afterthought main [plur1bus:host-dispatch-unavailable]",
      disable: true,
    }]);
  });

  it("probes the complete native CLI capability and fails closed on missing or throwing help", () => {
    const complete = probeNativeCronCommandDispatch((args) => ({
      ok: true,
      stdout: args[0] === "cron"
        ? "--command-argv <json> --timeout-seconds <n> --output-max-bytes <n>"
        : "Run an agent turn via the Gateway --agent --session-key --channel --message --timeout",
      stderr: "",
      status: 0,
    }));
    assert.deepStrictEqual(complete, { ready: true, status: "native-command" });

    assert.throws(
      () => probeNativeCronCommandDispatch(() => ({ ok: true, stdout: "--message", stderr: "", status: 0 })),
      /native cron command capability unavailable/i,
    );
    assert.throws(
      () => probeNativeCronCommandDispatch(() => { throw new Error("help failed"); }),
      /help failed/,
    );
  });

  it("uses native mode without applying the legacy patch", async () => {
    const calls = [];
    const stdout = captureStream();
    const exitCode = await runSetupFeatureCrons({
      argv: ["--json"],
      stdout: stdout.stream,
      ensureCronDirectDispatchImpl: () => ({ ready: true, status: "native-command" }),
      openclawImpl: (args) => {
        calls.push(args);
        if (args[0] === "--version") return { ok: true, stdout: "test", stderr: "", status: 0 };
        if (args.join(" ") === "gateway call config.get --json") {
          return {
            ok: true,
            stdout: JSON.stringify({
              valid: true,
              sourceConfig: {
                plugins: { entries: { "memory-lancedb-namespaced": { config: { afterthought: { enabled: true }, skillMiner: { enabled: true } } } } },
              },
              runtimeConfig: { agents: { entries: [{ id: "main", default: true }] } },
            }),
            stderr: "",
            status: 0,
          };
        }
        if (args.join(" ") === "agents list --json") {
          return { ok: true, stdout: JSON.stringify([{ id: "main", isDefault: true, bindings: 1, workspace: "/lab/main" }]), stderr: "", status: 0 };
        }
        if (args.join(" ") === "cron list --json --all") {
          return { ok: true, stdout: JSON.stringify({ jobs: [] }), stderr: "", status: 0 };
        }
        return { ok: true, stdout: "{}", stderr: "", status: 0 };
      },
    });

    assert.equal(exitCode, 0);
    const creates = calls.filter((args) => args[0] === "cron" && args[1] === "add");
    assert.ok(creates.length > 0);
    assert.ok(creates.every((args) => args.includes("--command-argv") && !args.includes("--message")));
  });

  it("does not fall back to a second execution when a native command fails", () => {
    const args = buildAddArgs(nativeJob(), { dispatchMode: "native-command" });
    const argv = JSON.parse(args[args.indexOf("--command-argv") + 1]);

    assert.equal(argv.filter((part) => part === "openclaw").length, 1);
    assert.equal(args.includes("--message"), false);
    assert.equal(args.includes("--command"), false);
  });
});
