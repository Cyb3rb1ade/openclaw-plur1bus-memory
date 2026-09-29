// tests/dist-installer-gateway-status.test.js — `gateway status --json` fails closed for the
// T6-e restore gate (HM1 Task 8 carry): only a definite "nothing listens" answer counts as
// stopped; a timeout, a non-zero exit, unparseable output or an RPC failure that is not
// "unreachable" counts as running. The feature-cron step (HM1-R7) runs only for a
// confirmed running Gateway. Fake `run` functions only; never a real OpenClaw.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createOpenclawCli } from "../scripts/dist/installer/openclaw-cli.mjs";
import { waitForGatewayStopped } from "../scripts/dist/installer/update.mjs";
import { EXIT } from "../scripts/dist/installer/report.mjs";
import { createInstallerSandbox, runSandboxInstaller } from "./helpers/installer-sandbox.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const STOPPED = JSON.parse(readFileSync(join(REPO, "tests", "fixtures", "openclaw-cli", "gateway-status-stopped.json"), "utf8"));

/** A cli whose only command answers `gateway status --json` with `result`. */
function cliAnswering(result) {
  const calls = [];
  const run = async (_bin, args) => {
    calls.push(args);
    assert.deepEqual(args, ["gateway", "status", "--json"]);
    return { code: 0, stdout: "", stderr: "", timedOut: false, ...result };
  };
  return { cli: createOpenclawCli({ bin: "openclaw", env: {}, run }), calls };
}

const status = (mutate = (j) => j) => JSON.stringify(mutate(structuredClone(STOPPED)), null, 2);

describe("plugin installer: gateway status fails closed (T6-e)", () => {
  it("a stopped Gateway (exit 0, rpc unreachable, port free) is not running", async () => {
    const { cli } = cliAnswering({ stdout: status() });
    const gw = await cli.gatewayStatus();
    assert.equal(gw.running, false);
    assert.equal(gw.confirmed, false);
  });

  it("a version without connectFailure: ECONNREFUSED with an unknown port is not running", async () => {
    const { cli } = cliAnswering({ stdout: status((j) => ({ ...j, rpc: { ok: false, error: "connect ECONNREFUSED 127.0.0.1:18789" }, port: undefined })) });
    assert.equal((await cli.gatewayStatus()).running, false);
  });

  it("rpc ok is a confirmed running Gateway", async () => {
    const { cli } = cliAnswering({ stdout: status((j) => ({ ...j, rpc: { ...j.rpc, ok: true, connectFailure: undefined } })) });
    const gw = await cli.gatewayStatus();
    assert.equal(gw.running, true);
    assert.equal(gw.confirmed, true);
  });

  const ambiguous = [
    ["a non-zero exit", { code: 1, stdout: status() }],
    ["a deadline exceeded", { code: 124, timedOut: true, stdout: "" }],
    ["openclaw not runnable", { code: 127, stdout: "" }],
    ["unparseable output", { stdout: "Gateway: not sure\n" }],
    ["JSON without rpc", { stdout: status((j) => ({ ...j, rpc: undefined })) }],
    ["an RPC failure that is not unreachable (auth)", { stdout: status((j) => ({ ...j, rpc: { ...j.rpc, connectFailure: { kind: "auth" }, error: "unauthorized" } })) }],
    ["an RPC timeout", { stdout: status((j) => ({ ...j, rpc: { ...j.rpc, connectFailure: { kind: "timeout" }, error: "timeout" } })) }],
    ["unreachable RPC while the port is busy", { stdout: status((j) => ({ ...j, port: { ...j.port, status: "busy" } })) }],
    ["no connect failure kind, a non-refused error and an unknown port", { stdout: status((j) => ({ ...j, rpc: { ...j.rpc, connectFailure: undefined, error: "connect ETIMEDOUT 127.0.0.1:18789" }, port: { ...j.port, status: "unknown" } })) }],
  ];
  for (const [label, result] of ambiguous) {
    it(`${label} counts as running (not confirmed)`, async () => {
      const { cli } = cliAnswering(result);
      const gw = await cli.gatewayStatus();
      assert.equal(gw.running, true, label);
      assert.equal(gw.confirmed, false, label);
      assert.equal(typeof gw.detail, "string");
    });
  }

  it("the restore gate refuses a restore when the status is ambiguous (non-interactive)", async () => {
    const { cli, calls } = cliAnswering({ code: 124, timedOut: true, stdout: "" });
    assert.equal(await waitForGatewayStopped({ cli, isTTY: false, flags: {} }), false);
    assert.equal(calls.length, 1);
  });

  it("the restore gate lets a definitely stopped Gateway through", async () => {
    const { cli } = cliAnswering({ stdout: status() });
    assert.equal(await waitForGatewayStopped({ cli, isTTY: false, flags: {} }), true);
  });

  it("an ambiguous status never runs the feature cron script (HM1-R7 needs a confirmed Gateway)", async () => {
    const sb = createInstallerSandbox({ scenario: { gatewayAmbiguous: true } });
    const r = await runSandboxInstaller(sb, ["--source", "npm"]);
    assert.equal(r.code, EXIT.OK, r.out);
    assert.ok(sb.openclawCalls().some((a) => a.join(" ") === "gateway status --json"));
    assert.equal(sb.log().filter((e) => e.bin === "node" && String(e.argv[0]).endsWith("setup-feature-crons.mjs")).length, 0);
    assert.match(r.stderr, /crons.*skipped|skipped.*crons|gateway-start-reconciles|not confirmed/i);
  });
});
