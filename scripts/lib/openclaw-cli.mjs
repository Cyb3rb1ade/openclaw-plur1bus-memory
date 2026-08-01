/**
 * openclaw-cli.mjs — shared spawnSync wrapper around the `openclaw` CLI,
 * used by every PLUR1BUS setup/repair script that shells out to it
 * (setup-feature-crons.mjs, repair-dreaming-cron.mjs, ...). Runs entirely
 * as the invoking user — no root, no sudo, no system paths.
 */

import { spawnSync } from "node:child_process";

/**
 * @param {string[]} args — argv passed to the `openclaw` binary
 * @param {number} [timeout] — timeout in ms (default 15000)
 * @param {{env?: object}} [options] — optional environment override
 * @returns {{ok: boolean, stdout: string, stderr: string, status: number|null, error: Error|undefined}}
 */
export function openclaw(args, timeout = 15000, options = {}) {
  const r = spawnSync("openclaw", args, { encoding: "utf8", timeout, ...(options.env ? { env: options.env } : {}) });
  return { ok: r.status === 0 && !r.error, stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status, error: r.error };
}
