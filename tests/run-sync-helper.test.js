import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { execFileSyncBounded, execSyncBounded, spawnSyncBounded } from "./helpers/run-sync.js";

const HANG = ["-e", "setInterval(() => {}, 1000)"];

describe("tests/helpers/run-sync bounded children", () => {
  it("spawnSyncBounded passes results through and applies a default bound", () => {
    const result = spawnSyncBounded(process.execPath, ["-e", "process.stdout.write('ok')"], { encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "ok");
  });

  it("spawnSyncBounded throws naming the command when the child hangs", () => {
    assert.throws(
      () => spawnSyncBounded(process.execPath, HANG, { timeout: 200 }),
      (error) => error.code === "ETIMEDOUT" && error.message.includes("timed out") && error.message.includes("setInterval"),
    );
  });

  it("execFileSyncBounded throws naming the command when the child hangs, and keeps ordinary failures intact", () => {
    assert.throws(
      () => execFileSyncBounded(process.execPath, HANG, { timeout: 200 }),
      (error) => error.code === "ETIMEDOUT" && error.message.includes("setInterval"),
    );
    assert.throws(
      () => execFileSyncBounded(process.execPath, ["-e", "process.exit(3)"], { stdio: "ignore" }),
      (error) => error.status === 3 && error.code !== "ETIMEDOUT",
    );
  });

  it("execSyncBounded throws naming the command line when the child hangs", { skip: process.platform === "win32" && "posix shell command" }, () => {
    assert.throws(
      () => execSyncBounded("sleep 30", { timeout: 200, stdio: "ignore" }),
      (error) => error.code === "ETIMEDOUT" && error.message.includes("sleep 30"),
    );
  });
});
