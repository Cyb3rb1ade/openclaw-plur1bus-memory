// tests/dist-installer-failure-summary.test.js — how the installer summarises a failed `openclaw` call
// (plugin-dist run 36518766808, Windows): OpenClaw's generic failure block (src/cli/failure-output.ts in 2026.8.1
// and 2026.9.6) is "[openclaw] <title>" / "[openclaw] Reason: <message>" / "[openclaw] Debug: set OPENCLAW_DEBUG=1
// …" / "[openclaw] Try: openclaw doctor" / "[openclaw] Help: openclaw --help". The old summary kept the last three
// lines — exactly the three hints — and dropped the error. `plugins uninstall` also prints its directory-removal
// warning on stdout. Fake `run` functions only; never a real OpenClaw.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createOpenclawCli, failureSummary } from "../scripts/dist/installer/openclaw-cli.mjs";

const HINTS = ["[openclaw] Debug: set OPENCLAW_DEBUG=1 to include the stack trace.", "[openclaw] Try: openclaw doctor", "[openclaw] Help: openclaw --help"];
const TARGET = "D:\\a\\_temp\\oc-state\\npm\\projects\\cyb3rb1ade-plur1bus-memory-1a2b";
const UNINSTALL_STDERR = ["[openclaw] Command failed", `[openclaw] Reason: Failed to remove plugin directory ${TARGET}; the plugin remains disabled and tracked so uninstall can be retried.`, ...HINTS].join("\r\n") + "\r\n";
const UNINSTALL_STDOUT = [
  "Plugin: PLUR1BUS Memory (memory-lancedb-namespaced)",
  `Will remove: config entry, install record, memory slot (will reset to "memory-core"), directory: ${TARGET}`,
  `Failed to remove plugin directory ${TARGET}: EPERM: operation not permitted, unlink '${TARGET}\\node_modules\\@lancedb\\lancedb-win32-x64-msvc\\lancedb.win32-x64-msvc.node'`,
].join("\r\n") + "\r\n";

describe("plugin installer: failure summary of an openclaw call", () => {
  it("drops OpenClaw's Debug/Try/Help hints and keeps the error (the exact run 36518766808 shape)", () => {
    const s = failureSummary({ stderr: `${HINTS.join("\n")}\n`, stdout: "" });
    assert.equal(s, "(no error text from openclaw)");
    const full = failureSummary({ stderr: UNINSTALL_STDERR, stdout: "" });
    assert.match(full, /^\[openclaw\] Command failed \| \[openclaw\] Reason: Failed to remove plugin directory /);
    assert.doesNotMatch(full, /OPENCLAW_DEBUG|openclaw doctor|openclaw --help/);
  });

  it("adds error lines from stdout (the EPERM of the directory removal) after the stderr error", () => {
    const s = failureSummary({ stderr: UNINSTALL_STDERR, stdout: UNINSTALL_STDOUT });
    assert.match(s, /Reason: Failed to remove plugin directory/);
    assert.match(s, /EPERM: operation not permitted, unlink .*lancedb\.win32-x64-msvc\.node/);
    assert.doesNotMatch(s, /Will remove:|^Plugin:/);
  });

  it("uses stdout when stderr has nothing meaningful, and skips Node warnings and blank lines", () => {
    const s = failureSummary({ stderr: "(node:4242) ExperimentalWarning: SQLite is an experimental feature\n(Use `node --trace-warnings ...` to show where the warning was created)\n\n", stdout: "Error: something broke\nsecond line\nthird\nfourth\n" });
    assert.equal(s, "Error: something broke | second line | third");
    assert.equal(failureSummary("just text\n"), "just text");
    assert.equal(failureSummary({ stderr: "\u001b[31m[openclaw] Reason: boom\u001b[0m\n" }), "[openclaw] Reason: boom");
  });

  it("uninstall's failure detail carries the reason (cli.uninstall retries a failed directory removal)", async () => {
    const calls = [];
    const sleeps = [];
    const run = async (_bin, args) => {
      calls.push(args);
      return { code: 1, stdout: UNINSTALL_STDOUT, stderr: UNINSTALL_STDERR, timedOut: false };
    };
    const cli = createOpenclawCli({ bin: "openclaw", env: {}, run, sleep: async (ms) => sleeps.push(ms) });
    const r = await cli.uninstall("memory-lancedb-namespaced");
    assert.equal(r.code, 1);
    assert.equal(calls.length, 3, "OpenClaw says the uninstall can be retried: three attempts");
    assert.deepEqual(sleeps, [2000, 4000]);
    assert.match(r.summary, /EPERM/);
  });

  it("any other uninstall failure is not retried", async () => {
    const calls = [];
    const run = async (_bin, args) => {
      calls.push(args);
      return { code: 1, stdout: "", stderr: ["[openclaw] Command failed", "[openclaw] Reason: config write refused", ...HINTS].join("\n"), timedOut: false };
    };
    const cli = createOpenclawCli({ bin: "openclaw", env: {}, run, sleep: async () => assert.fail("no sleep") });
    const r = await cli.uninstall("memory-lancedb-namespaced");
    assert.equal(calls.length, 1);
    assert.match(r.summary, /Reason: config write refused/);
  });

  it("a retried uninstall that then succeeds returns exit 0", async () => {
    let n = 0;
    const run = async () => (++n === 1 ? { code: 1, stdout: UNINSTALL_STDOUT, stderr: UNINSTALL_STDERR, timedOut: false } : { code: 0, stdout: "Uninstalled plugin \"memory-lancedb-namespaced\".\n", stderr: "", timedOut: false });
    const cli = createOpenclawCli({ bin: "openclaw", env: {}, run, sleep: async () => {} });
    assert.equal((await cli.uninstall("memory-lancedb-namespaced")).code, 0);
    assert.equal(n, 2);
  });
});
