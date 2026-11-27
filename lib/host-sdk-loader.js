/**
 * lib/host-sdk-loader.js — the one seam lib/ uses to reach a host SDK module
 * (e.g. OpenClaw's memory-host-events or secret-input runtime) without
 * importing the host. The OpenClaw adapter installs its loader at
 * registration; without one, every load rejects and callers fail open as
 * they already do on a missing SDK.
 */

let loader = null;

/** @param {((subpath: string, options?: object) => Promise<unknown>)|null} next */
export function setHostSdkLoader(next) {
  loader = typeof next === "function" ? next : null;
}

/**
 * @param {string} subpath
 * @param {object} [options]
 * @returns {Promise<unknown>}
 */
export async function loadHostSdk(subpath, options = {}) {
  if (!loader) throw new Error(`host SDK capability ${subpath} is not available on this host`);
  return loader(subpath, options);
}
