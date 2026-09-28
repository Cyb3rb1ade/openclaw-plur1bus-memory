/**
 * tests/selftest-cli.test.js — HM1 Task 2: the OpenClaw binding of
 * `openclaw plur1bus selftest` (lib/setup/selftest-plugin-runtime.js).
 *
 * The builder runs against a real commander program (the library OpenClaw
 * itself hands to plugin CLI builders), so option parsing, the root/subcommand
 * shape and usage errors are exercised as OpenClaw would run them.
 */

import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

import { Command } from "commander";

import { SELFTEST_CLI_ROOT, SELFTEST_CLI_SUBCOMMAND, registerSelftestRuntime } from "../lib/setup/selftest-plugin-runtime.js";
import { SELFTEST_SCHEMA, SELFTEST_STEPS } from "../lib/selftest/run-selftest.js";

function report(ok, overrides = {}) {
  return {
    schema: SELFTEST_SCHEMA,
    ok,
    pluginVersion: "7.17.0",
    node: process.version,
    target: `${process.platform}-${process.arch}`,
    addons: [
      { name: "@lancedb/lancedb", ok },
      { name: "onnxruntime-node", ok: true },
      { name: "sharp", ok: true },
    ],
    model: { profile: "intfloat/multilingual-e5-small", revision: "614241f622f53c4eeff9890bdc4f31cfecc418b3", state: "present" },
    steps: SELFTEST_STEPS.map((id) => ({ id, ok: true, ms: 1 })),
    harnessHome: null,
    warnings: [],
    errors: ok ? [] : ["addon @lancedb/lancedb failed to load (@lancedb/lancedb-linux-x64-gnu)"],
    ...overrides,
  };
}

function harness({ runResult = report(true), pluginConfig = { language: "en" } } = {}) {
  const clis = [];
  const out = [];
  const err = [];
  const runs = [];
  const exits = [];
  const exitCodes = [];
  const api = {
    pluginConfig,
    registerCli: (builder, options) => clis.push({ builder, options }),
  };
  registerSelftestRuntime({
    api,
    write: (chunk) => out.push(chunk),
    writeErr: (chunk) => err.push(chunk),
    setExitCode: (code) => exitCodes.push(code),
    exit: (code) => { exits.push(code); throw Object.assign(new Error(`exit ${code}`), { exitCalled: code }); },
    run: async (options) => { runs.push(options); return typeof runResult === "function" ? runResult(options) : runResult; },
  });
  const program = new Command("openclaw");
  program.exitOverride();
  program.configureOutput({ writeOut: (chunk) => out.push(chunk), writeErr: (chunk) => err.push(chunk) });
  for (const cli of clis) cli.builder({ program });
  const parse = (args) => program.parseAsync(["node", "openclaw", ...args]);
  return { clis, out, err, runs, exits, exitCodes, program, parse };
}

describe("openclaw plur1bus selftest", () => {
  it("registers root plur1bus with subcommand selftest", () => {
    const { clis, program } = harness();
    assert.equal(clis.length, 1);
    assert.deepEqual(clis[0].options.descriptors.map(({ name, hasSubcommands }) => ({ name, hasSubcommands })), [
      { name: "plur1bus", hasSubcommands: true },
    ]);
    assert.equal(typeof clis[0].options.descriptors[0].description, "string");
    assert.equal(SELFTEST_CLI_ROOT, "plur1bus");
    assert.equal(SELFTEST_CLI_SUBCOMMAND, "selftest");
    const root = program.commands.find((command) => command.name() === "plur1bus");
    assert.ok(root, "root command registered");
    const selftest = root.commands.find((command) => command.name() === "selftest");
    assert.ok(selftest, "subcommand selftest registered");
    assert.deepEqual(
      selftest.options.map((option) => option.long).sort(),
      ["--download-models", "--json", "--keep", "--remote", "--state-dir"],
    );
  });

  it("--json prints one plur1bus.selftest/1 document and exits 1 on failure", async () => {
    const h = harness({ runResult: report(false) });
    const stateDir = join("/tmp", "p b", "Jürgen");
    await h.parse(["plur1bus", "selftest", "--json", "--download-models", "--state-dir", stateDir]);
    assert.equal(h.out.length, 1, "exactly one write on stdout");
    const doc = JSON.parse(h.out[0]);
    assert.equal(doc.schema, "plur1bus.selftest/1");
    assert.equal(doc.ok, false);
    assert.deepEqual(h.exitCodes, [1]);
    assert.equal(h.runs.length, 1);
    assert.equal(h.runs[0].stateDir, resolve(stateDir));
    assert.equal(h.runs[0].downloadModels, true);
    assert.equal(h.runs[0].remote, false);
    assert.equal(h.runs[0].keep, false);
    assert.deepEqual(h.runs[0].pluginConfig, { language: "en" });

    const ok = harness();
    await ok.parse(["plur1bus", "selftest", "--json"]);
    assert.equal(JSON.parse(ok.out.join("")).ok, true);
    assert.deepEqual(ok.exitCodes, [0]);
    assert.equal(ok.runs[0].stateDir, undefined, "no --state-dir leaves the default to runSelftest");
  });

  it("prints one line per addon and step, then the verdict", async () => {
    const failed = harness({ runResult: report(false, { steps: [...report(false).steps.slice(0, 6), { id: "store.delete", ok: true, ms: 1, skipped: "keep", detail: "/tmp/x/plur1bus-selftest-abc" }] }) });
    await failed.parse(["plur1bus", "selftest", "--keep", "--remote"]);
    const lines = failed.out.join("").trimEnd().split("\n");
    assert.equal(lines.length, 3 + SELFTEST_STEPS.length + 1);
    assert.match(lines[0], /@lancedb\/lancedb/);
    assert.match(lines[3], /coexistence/);
    assert.match(lines[3 + SELFTEST_STEPS.length - 1], /skipped store\.delete: keep.*plur1bus-selftest-abc/);
    assert.equal(lines.at(-1), "selftest failed: addon @lancedb/lancedb failed to load (@lancedb/lancedb-linux-x64-gnu)");
    assert.deepEqual(failed.exitCodes, [1]);
    assert.equal(failed.runs[0].keep, true);
    assert.equal(failed.runs[0].remote, true);

    const ok = harness();
    await ok.parse(["plur1bus", "selftest"]);
    assert.equal(ok.out.join("").trimEnd().split("\n").at(-1), "selftest ok");
    assert.deepEqual(ok.exitCodes, [0]);
  });

  it("a usage error exits 2 without running the selftest", async () => {
    for (const args of [["plur1bus", "selftest", "--bogus"], ["plur1bus", "selftest", "extra"], ["plur1bus", "selftest", "--state-dir"]]) {
      const h = harness();
      await assert.rejects(() => h.parse(args), (error) => error.exitCalled === 2 || h.exitCodes.includes(2), args.join(" "));
      assert.ok(h.exits.includes(2) || h.exitCodes.includes(2), args.join(" "));
      assert.equal(h.runs.length, 0, args.join(" "));
    }
  });

  it("a selftest that throws is still one failed document", async () => {
    const h = harness({ runResult: () => { throw new Error("engine exploded"); } });
    await h.parse(["plur1bus", "selftest", "--json"]);
    const doc = JSON.parse(h.out.join(""));
    assert.equal(doc.schema, SELFTEST_SCHEMA);
    assert.equal(doc.ok, false);
    assert.match(doc.errors[0], /engine exploded/);
    assert.deepEqual(h.exitCodes, [1]);
  });
});
