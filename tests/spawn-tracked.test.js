import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { execFileBounded, runTracked, spawnTracked, waitForOutput } from "./helpers/spawn-tracked.js";

const HANG = "setInterval(() => {}, 1000);";
// Ignores SIGTERM, so only the SIGKILL escalation can end it.
const HANG_IGNORING_SIGTERM = "process.on('SIGTERM', () => {}); process.stdout.write('up'); setInterval(() => {}, 1000);";

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("tests/helpers/spawn-tracked.js", { timeout: 60_000 }, () => {
  it("a never-ready child is killed and reported with its command line", async (t) => {
    const child = spawnTracked(t, process.execPath, ["-e", HANG], { stdio: ["ignore", "pipe", "pipe"] });
    const pid = child.pid;
    await assert.rejects(
      waitForOutput(child, { timeoutMs: 300, label: "fixture owner" }),
      (error) => {
        assert.match(error.message, /fixture owner not ready after 300 ms/);
        assert.ok(error.message.includes(process.execPath), error.message);
        return true;
      },
    );
    const { signal } = await child.exited;
    assert.ok(signal, "the child ended by signal, not by itself");
    assert.equal(isAlive(pid), false);
  });

  it("a child that exits before it is ready is reported with its stderr", async (t) => {
    const child = spawnTracked(t, process.execPath, ["-e", "console.error('boom'); process.exit(3)"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    await assert.rejects(waitForOutput(child, { timeoutMs: 10_000, label: "fixture owner" }), /exited before ready \(3\).*boom/s);
  });

  it("waitForOutput resolves with output already received and honours a match", async (t) => {
    const child = spawnTracked(t, process.execPath, ["-e", `process.stdout.write('ready'); ${HANG}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(await waitForOutput(child, { match: "ready", timeoutMs: 10_000 }), "ready");
    assert.equal(await waitForOutput(child, { match: /rea/, timeoutMs: 10_000 }), "ready");
  });

  it("teardown kills a child that ignores SIGTERM and awaits its exit", async (t) => {
    let pid;
    await t.test("inner test spawns and leaves the child running", async (inner) => {
      const child = spawnTracked(inner, process.execPath, ["-e", HANG_IGNORING_SIGTERM], {
        stdio: ["ignore", "pipe", "pipe"],
        killGraceMs: 100,
      });
      pid = child.pid;
      await waitForOutput(child, { match: "up", timeoutMs: 10_000 });
      assert.equal(isAlive(pid), true);
    });
    assert.equal(isAlive(pid), false, "inner test teardown reaped the child");
  });

  it("runTracked returns output, and kills and reports a child that hits the deadline", async (t) => {
    const ok = await runTracked(t, process.execPath, ["-e", "process.stdout.write('hi')"], { stdio: ["ignore", "pipe", "pipe"] });
    assert.deepEqual({ code: ok.code, stdout: ok.stdout }, { code: 0, stdout: "hi" });

    await assert.rejects(
      runTracked(t, process.execPath, ["-e", HANG_IGNORING_SIGTERM], { stdio: ["ignore", "pipe", "pipe"], timeoutMs: 300 }),
      /timed out after 300 ms and was killed \(SIGKILL\)/,
    );
  });

  it("execFileBounded kills at the timeout and names the command", async () => {
    await assert.rejects(
      execFileBounded(process.execPath, ["-e", HANG_IGNORING_SIGTERM], { timeout: 300 }),
      (error) => {
        assert.equal(error.code, "ETIMEDOUT");
        assert.match(error.message, /timed out after 300 ms and was killed \(SIGKILL\)/);
        return true;
      },
    );
    const ok = await execFileBounded(process.execPath, ["-e", "process.stdout.write('fine')"]);
    assert.equal(ok.stdout, "fine");
  });
});
