/**
 * tests/helpers/run-sync.js
 *
 * Bounded synchronous child processes for tests.
 *
 * A `spawnSync` / `execFileSync` / `execSync` without `timeout` blocks the event
 * loop, so node:test's `--test-timeout` can never fire: a wedged child hangs the
 * whole job until the CI runner kills it. These wrappers apply a default
 * `timeout` and `killSignal: "SIGKILL"` (so a child that ignores SIGTERM cannot
 * outlive the limit) and turn a timed-out child into a thrown error that names
 * the command. Caller options win, so a call that needs a different limit can
 * pass its own `timeout`.
 */

import { execFileSync, execSync, spawnSync } from "node:child_process";

export const DEFAULT_SYNC_TIMEOUT_MS = 60_000;

const bounded = (options) => ({
  timeout: DEFAULT_SYNC_TIMEOUT_MS,
  killSignal: "SIGKILL",
  ...options,
});

const describeCommand = (command, args) =>
  [command, ...(Array.isArray(args) ? args : [])].map(String).join(" ").slice(0, 300);

const timeoutMessage = (command, args, options) =>
  `child process timed out after ${options.timeout} ms and was killed (${options.killSignal}): ${describeCommand(command, args)}`;

/** Drop-in `spawnSync`; throws if the child hit its timeout. */
export function spawnSyncBounded(command, args, options) {
  if (args !== undefined && !Array.isArray(args)) {
    options = args;
    args = [];
  }
  const opts = bounded(options);
  const result = spawnSync(command, args ?? [], opts);
  if (result.error?.code === "ETIMEDOUT") {
    throw Object.assign(new Error(timeoutMessage(command, args, opts)), { code: "ETIMEDOUT", result });
  }
  return result;
}

function rethrowTimeout(error, command, args, opts) {
  if (error?.code === "ETIMEDOUT") error.message = timeoutMessage(command, args, opts);
  throw error;
}

/** Drop-in `execFileSync`; a timeout rethrows with the command name (other errors untouched). */
export function execFileSyncBounded(command, args, options) {
  if (args !== undefined && !Array.isArray(args)) {
    options = args;
    args = [];
  }
  const opts = bounded(options);
  try {
    return execFileSync(command, args ?? [], opts);
  } catch (error) {
    return rethrowTimeout(error, command, args, opts);
  }
}

/** Drop-in `execSync`; a timeout rethrows with the command line (other errors untouched). */
export function execSyncBounded(command, options) {
  const opts = bounded(options);
  try {
    return execSync(command, opts);
  } catch (error) {
    return rethrowTimeout(error, command, undefined, opts);
  }
}
