/**
 * lib/setup/selftest-plugin-runtime.js — the OpenClaw binding of
 * `openclaw plur1bus selftest` (HM1 Task 2, HM1-R5, spec A.4).
 *
 *   openclaw plur1bus selftest [--json] [--download-models] [--remote] [--keep] [--state-dir <dir>]
 *
 * Root `plur1bus` with `hasSubcommands: true` (fact sheet (i): accepted by
 * OpenClaw 2026.8.1 and 2026.9.6, runs in the CLI process without a
 * Gateway). Registered on every register() call that offers `registerCli`,
 * independent of `registerGatewayMethod`. The action reads only
 * `api.pluginConfig` and lazy-imports lib/selftest/run-selftest.js, so a
 * plain CLI start never loads the selftest.
 *
 * Exit codes: 0 ok, 1 a non-skipped step or an addon failed, 2 usage.
 * `--json` writes exactly one `plur1bus.selftest/1` document on stdout.
 */

import { resolve } from "node:path";

import { HARNESS_COEXISTENCE_NOTICE } from "./harness-coexistence.js";

export const SELFTEST_CLI_ROOT = "plur1bus";
export const SELFTEST_CLI_SUBCOMMAND = "selftest";
export const SELFTEST_CLI_DESCRIPTION = "PLUR1BUS maintenance commands (selftest)";

const SCHEMA = "plur1bus.selftest/1";

async function lazyRunSelftest(options) {
  const { runSelftest } = await import("../selftest/run-selftest.js");
  return runSelftest(options);
}

/**
 * Human output: one line per addon and step, then the verdict.
 * @param {object} report SelftestReport.
 * @returns {string}
 */
export function formatSelftestReport(report) {
  const lines = [];
  for (const addon of report.addons ?? []) {
    const detail = `${addon.package ?? ""}${addon.error ? ` (${addon.error})` : ""}`;
    if (addon.ok) lines.push(`ok      addon ${addon.name}`);
    else if (addon.name === "sharp") lines.push(`degraded addon ${addon.name}: ${detail}`);
    else lines.push(`FAILED  addon ${addon.name}: ${detail}`);
  }
  for (const step of report.steps ?? []) {
    const detail = step.detail ? ` (${step.detail})` : "";
    if (step.skipped) lines.push(`skipped ${step.id}: ${step.skipped}${detail}`);
    else if (step.ok) lines.push(`ok      ${step.id} ${step.ms} ms${detail}`);
    else lines.push(`FAILED  ${step.id}${detail}`);
  }
  // HM4: one info line when a Harness is found and the store is outside it.
  const coexistence = (report.steps ?? []).find((step) => step.id === "coexistence");
  if (report.harnessHome && coexistence?.ok) {
    lines.push(`info    ${HARNESS_COEXISTENCE_NOTICE}`);
  }
  lines.push(report.ok ? "selftest ok" : `selftest failed: ${report.errors?.[0] ?? "unknown error"}`);
  return `${lines.join("\n")}\n`;
}

function failedReport(error) {
  return {
    schema: SCHEMA,
    ok: false,
    pluginVersion: null,
    node: process.version,
    target: `${process.platform}-${process.arch}`,
    addons: [],
    model: { profile: null, revision: null, state: "skipped" },
    steps: [],
    harnessHome: null,
    capabilities: [],
    warnings: [],
    errors: [`selftest crashed: ${String(error?.message ?? error).split("\n")[0].slice(0, 300)}`],
  };
}

/**
 * Register `openclaw plur1bus selftest` with OpenClaw.
 * @param {object} input
 * @param {object} input.api OpenClaw plugin API (needs `registerCli`).
 * @param {(chunk: string) => void} [input.write] stdout writer.
 * @param {(chunk: string) => void} [input.writeErr] stderr writer.
 * @param {(options: object) => Promise<object>} [input.run] The selftest (default: lazy runSelftest).
 * @param {(code: number) => void} [input.setExitCode] Sets the process exit code after the action.
 * @param {(code: number) => void} [input.exit] Exits immediately (usage errors).
 * @returns {void}
 */
export function registerSelftestRuntime({
  api,
  write = (chunk) => process.stdout.write(chunk),
  writeErr = (chunk) => process.stderr.write(chunk),
  run = lazyRunSelftest,
  setExitCode = (code) => { process.exitCode = code; },
  exit = (code) => process.exit(code),
} = {}) {
  if (typeof api?.registerCli !== "function") {
    throw new Error("OpenClaw registerCli capability unavailable for the PLUR1BUS selftest");
  }
  api.registerCli(({ program }) => {
    const root = program
      .command(SELFTEST_CLI_ROOT)
      .description(SELFTEST_CLI_DESCRIPTION);
    root
      .command(SELFTEST_CLI_SUBCOMMAND)
      .description("Check native addons, the embedding model and a throw-away store round trip")
      .option("--json", "print one plur1bus.selftest/1 JSON document")
      .option("--download-models", "download a missing embedding model")
      .option("--remote", "also call a configured remote embedding provider")
      .option("--keep", "keep the throw-away store and print its path")
      .option("--state-dir <dir>", "directory for the throw-away store (default: the OpenClaw state dir)")
      // Usage errors (unknown option, missing value, extra argument) exit 2;
      // help keeps commander's exit 0.
      .exitOverride((error) => {
        if (error?.exitCode === 0) exit(0);
        else exit(2);
        throw error;
      })
      .action(async (options) => {
        let report;
        try {
          report = await run({
            ...(options.stateDir ? { stateDir: resolve(options.stateDir) } : {}),
            pluginConfig: api.pluginConfig && typeof api.pluginConfig === "object" ? api.pluginConfig : {},
            downloadModels: options.downloadModels === true,
            remote: options.remote === true,
            keep: options.keep === true,
            ...(typeof api.resolvePath === "function" ? { resolvePath: (value) => api.resolvePath(value) } : {}),
          });
        } catch (error) {
          report = failedReport(error);
        }
        if (options.json) write(`${JSON.stringify(report)}\n`);
        else write(formatSelftestReport(report));
        if (report.warnings?.length && !options.json) writeErr(`warnings: ${report.warnings.join(", ")}\n`);
        setExitCode(report.ok ? 0 : 1);
      });
  }, {
    descriptors: [{
      name: SELFTEST_CLI_ROOT,
      description: SELFTEST_CLI_DESCRIPTION,
      hasSubcommands: true,
      machineOutput: () => true,
    }],
  });
}
