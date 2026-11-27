/**
 * tests/helpers/spawn-tracked.js
 *
 * Bounded asynchronous child processes for tests (companion to run-sync.js).
 *
 * A child that is spawned and then waited on without a deadline outlives its
 * test: node:test's `--test-timeout` rejects the test, but nothing kills the
 * process, so it keeps running (and keeps the file runner's event loop alive)
 * until the CI runner gives up. These helpers make three guarantees:
 *
 *   - `spawnTracked(t, ...)` registers a `t.after()` teardown that kills the
 *     child (SIGTERM, then SIGKILL after a short grace) and awaits its exit,
 *     whether the test passed, failed or timed out.
 *   - `waitForOutput(child, ...)` is a bounded readiness wait: it rejects with
 *     the command line after `timeoutMs` (and on early exit), never hangs.
 *   - `execFileBounded(...)` / `runTracked(...)` apply a hard timeout with
 *     SIGKILL and rethrow a timeout naming the command.
 */

import { execFile, spawn } from "node:child_process";

export const DEFAULT_READY_TIMEOUT_MS = 15_000;
export const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
export const DEFAULT_KILL_GRACE_MS = 500;
// Upper bound on how long teardown waits for a SIGKILLed child to be reaped.
const REAP_TIMEOUT_MS = 5_000;

const describeCommand = (command, args) =>
  [command, ...(Array.isArray(args) ? args : [])].map(String).join(" ").slice(0, 300);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.());

const hasExited = (child) => child.exitCode !== null || child.signalCode !== null;

/**
 * Kill a tracked child and await its exit. SIGTERM first, SIGKILL once
 * `graceMs` elapsed without an exit. Resolves immediately for a child that is
 * already gone. Never rejects and never waits unbounded.
 */
export async function killTracked(child, { graceMs = DEFAULT_KILL_GRACE_MS } = {}) {
  if (hasExited(child)) return;
  const exited = child.exited ?? new Promise((resolve) => child.once("exit", resolve));
  const settled = (ms) => Promise.race([exited.then(() => true), sleep(ms).then(() => false)]);
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
  if (await settled(graceMs)) return;
  try { child.kill("SIGKILL"); } catch { /* already gone */ }
  await settled(REAP_TIMEOUT_MS);
}

/**
 * `spawn` plus teardown registration. The returned child has extra fields:
 *   `command`   the command line (for error messages)
 *   `exited`    Promise<{ code, signal }> that resolves once, on exit
 *   `output()`  { stdout, stderr } collected so far (piped stdio only)
 * Output is collected from spawn time so a readiness wait never misses data.
 * Pass `t` as the node:test TestContext (or any `{ after(fn) }`); pass `null`
 * only when the caller owns teardown and calls `killTracked` itself.
 */
export function spawnTracked(t, command, args, options) {
  if (args !== undefined && !Array.isArray(args)) {
    options = args;
    args = [];
  }
  const { killGraceMs, ...spawnOptions } = options ?? {};
  const child = spawn(command, args ?? [], spawnOptions);
  const out = { stdout: "", stderr: "" };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => { out.stdout += chunk; });
  child.stderr?.on("data", (chunk) => { out.stderr += chunk; });
  child.command = describeCommand(command, args);
  child.exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", () => resolve({ code: null, signal: null }));
  });
  child.output = () => ({ ...out });
  t?.after(() => killTracked(child, { graceMs: killGraceMs }));
  return child;
}

/**
 * Bounded readiness wait. Resolves with the collected stdout once it matches
 * `match` (default: any output). Rejects, killing the child, when the child
 * exits first or `timeoutMs` elapses; both messages carry the command line.
 */
export async function waitForOutput(child, { match = /[\s\S]/, timeoutMs = DEFAULT_READY_TIMEOUT_MS, label = "child" } = {}) {
  const matches = (text) => (match instanceof RegExp ? match.test(text) : text.includes(match));
  let timer;
  let onData;
  const cleanup = () => {
    clearTimeout(timer);
    if (onData) child.stdout?.off("data", onData);
  };
  const ready = new Promise((resolve, reject) => {
    const check = () => {
      const { stdout } = child.output();
      if (matches(stdout)) { resolve(stdout); return true; }
      return false;
    };
    if (check()) return;
    onData = () => { check(); };
    child.stdout?.on("data", onData);
    child.exited.then(({ code, signal }) => {
      if (check()) return;
      const { stdout, stderr } = child.output();
      reject(new Error(
        `${label} exited before ready (${code ?? signal}): ${child.command}; stdout=${JSON.stringify(stdout.slice(-500))} stderr=${JSON.stringify(stderr.slice(-2_000))}`,
      ));
    });
    timer = setTimeout(() => {
      const { stdout, stderr } = child.output();
      reject(new Error(
        `${label} not ready after ${timeoutMs} ms: ${child.command}; stdout=${JSON.stringify(stdout.slice(-500))} stderr=${JSON.stringify(stderr.slice(-2_000))}`,
      ));
    }, timeoutMs);
  });
  try {
    return await ready;
  } catch (error) {
    await killTracked(child, { graceMs: 0 });
    throw error;
  } finally {
    cleanup();
  }
}

/**
 * Run a child to completion with a hard deadline. Resolves
 * `{ code, signal, stdout, stderr }`; on timeout the child is SIGKILLed and the
 * promise rejects naming the command line.
 */
export async function runTracked(t, command, args, options) {
  if (args !== undefined && !Array.isArray(args)) {
    options = args;
    args = [];
  }
  const { timeoutMs = DEFAULT_EXEC_TIMEOUT_MS, ...spawnOptions } = options ?? {};
  const child = spawnTracked(t, command, args, spawnOptions);
  let timer;
  const timedOut = new Promise((resolve) => { timer = setTimeout(() => resolve(true), timeoutMs); });
  try {
    const finished = await Promise.race([child.exited.then(() => false), timedOut]);
    if (finished) {
      const { stdout, stderr } = child.output();
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      await killTracked(child, { graceMs: 0 });
      throw new Error(
        `child process timed out after ${timeoutMs} ms and was killed (SIGKILL): ${child.command}; stdout=${JSON.stringify(stdout.slice(-500))} stderr=${JSON.stringify(stderr.slice(-2_000))}`,
      );
    }
    const { code, signal } = await child.exited;
    return { code, signal, ...child.output() };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Promise `execFile` with a default `timeout` and `killSignal: "SIGKILL"`
 * (caller options win). A timeout rethrows with the command line; other
 * errors are untouched. Resolves `{ stdout, stderr }`.
 */
export function execFileBounded(command, args, options) {
  if (args !== undefined && !Array.isArray(args)) {
    options = args;
    args = [];
  }
  const opts = { timeout: DEFAULT_EXEC_TIMEOUT_MS, killSignal: "SIGKILL", ...options };
  return new Promise((resolve, reject) => {
    execFile(command, args ?? [], opts, (error, stdout, stderr) => {
      if (!error) { resolve({ stdout, stderr }); return; }
      if (error.killed && opts.timeout > 0) {
        error.message = `child process timed out after ${opts.timeout} ms and was killed (${opts.killSignal}): ${describeCommand(command, args)}`;
        error.code = "ETIMEDOUT";
      }
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}
