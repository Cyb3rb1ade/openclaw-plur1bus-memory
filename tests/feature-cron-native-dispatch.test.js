import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FEATURE_CRON_RUNNER_PATH,
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
  it("builds an exact plugin-owned Gateway command without an outer model carrier", () => {
    assert.deepStrictEqual(
      buildNativeFeatureCommandArgv({
        agentId: "main",
        feature: "afterthought",
        command: "/plur1bus internal afterthought",
      }),
      [
        process.execPath,
        FEATURE_CRON_RUNNER_PATH,
        "--agent",
        "main",
        "--feature",
        "afterthought",
      ],
    );
  });

  it("creates a native command payload with exactly one delivery owner", () => {
    const args = buildAddArgs(nativeJob());
    const commandIndex = args.indexOf("--command-argv");
    const argv = JSON.parse(args[commandIndex + 1]);

    assert.ok(commandIndex > -1);
    assert.equal(args.includes("--message"), false);
    assert.equal(args.filter((arg) => arg === "--announce").length, 1);
    assert.equal(argv.includes("--deliver"), false);
    assert.equal(argv.includes("--local"), false);
    assert.equal(argv[0], process.execPath);
    assert.equal(argv[1], FEATURE_CRON_RUNNER_PATH);
    assert.equal(argv[argv.indexOf("--agent") + 1], "main");
    assert.equal(argv[argv.indexOf("--feature") + 1], "afterthought");
    assert.deepStrictEqual(args.slice(commandIndex + 2, commandIndex + 6), [
      "--timeout-seconds",
      "600",
      "--output-max-bytes",
      "65536",
    ]);
  });

  it("derives the internal command inside the plugin boundary", () => {
    const argv = buildNativeFeatureCommandArgv({
      agentId: "main",
      feature: "classify-recent",
      command: "/plur1bus internal classify-recent",
    });
    assert.equal(argv.includes("--message"), false);
    assert.equal(argv.includes("/plur1bus internal classify-recent"), false);
    assert.equal(argv[argv.indexOf("--feature") + 1], "classify-recent");
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
    assert.equal(isNativeFeatureCommandPayload({ kind: "command", argv: [process.execPath, FEATURE_CRON_RUNNER_PATH, "--agent", "ops", "--feature", "custom"] }, {
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

  it("keeps native direct jobs fail-closed when the required capability is unavailable", () => {
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
        : "plur1bus-feature-cron --agent --feature",
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

  it("uses native mode without any mutation fallback", async () => {
    const calls = [];
    const stdout = captureStream();
    const exitCode = await runSetupFeatureCrons({
      argv: ["--json"],
      stdout: stdout.stream,
      probeNativeCronCommandDispatchImpl: () => ({ ready: true, status: "native-command" }),
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
    const args = buildAddArgs(nativeJob());
    const argv = JSON.parse(args[args.indexOf("--command-argv") + 1]);

    assert.equal(argv.filter((part) => part === FEATURE_CRON_RUNNER_PATH).length, 1);
    assert.equal(args.includes("--message"), false);
    assert.equal(args.includes("--command"), false);
  });
});
