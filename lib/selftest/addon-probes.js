/**
 * lib/selftest/addon-probes.js — load each native addon the plugin needs and
 * name the platform package when one does not load (HM1 Task 2, spec A.4).
 *
 * `openclaw plugins install` puts the dependencies into a managed npm project
 * with `--ignore-scripts`; a missing optional platform package (wrong libc,
 * wrong arch, an interrupted download) only shows up at import time. The
 * selftest imports each addon once and reports which platform artefact a
 * failure points at, so a user or the installer can act on it.
 *
 * No `api.` here (scripts/lint-no-api-outside-adapter.mjs).
 */

import { join } from "node:path";

export const NATIVE_ADDONS = Object.freeze(["@lancedb/lancedb", "onnxruntime-node", "sharp"]);

// onnxruntime-node ships every binding inside its own package, per N-API
// level, platform and arch (bin/napi-v6/<platform>/<arch>/).
const ONNX_NAPI_DIR = "napi-v6";

const LANCEDB_TRIPLES = Object.freeze({
  "linux-x64": "linux-x64-gnu",
  "linux-arm64": "linux-arm64-gnu",
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
  "win32-x64": "win32-x64-msvc",
  "win32-arm64": "win32-arm64-msvc",
});

/**
 * The platform artefact an addon loads on `platform`/`arch`.
 * @param {"@lancedb/lancedb"|"onnxruntime-node"|"sharp"} name Addon package.
 * @param {{platform?: string, arch?: string}} [target] Target platform.
 * @returns {string} Platform package name, or the binding path for onnxruntime-node.
 */
export function platformPackageFor(name, { platform = process.platform, arch = process.arch } = {}) {
  if (name === "@lancedb/lancedb") {
    return `@lancedb/lancedb-${LANCEDB_TRIPLES[`${platform}-${arch}`] ?? `${platform}-${arch}`}`;
  }
  if (name === "onnxruntime-node") {
    return join("onnxruntime-node", "bin", ONNX_NAPI_DIR, platform, arch, "onnxruntime_binding.node");
  }
  if (name === "sharp") return `@img/sharp-${platform}-${arch}`;
  throw new Error(`unknown native addon: ${String(name)}`);
}

function errorText(error) {
  return String(error?.message ?? error).split("\n")[0].slice(0, 300);
}

/**
 * Import every native addon once, in a fixed order.
 * @param {{importer?: (specifier: string) => Promise<unknown>, platform?: string, arch?: string}} [options]
 * @returns {Promise<Array<{name: "@lancedb/lancedb"|"onnxruntime-node"|"sharp", ok: boolean, package?: string, error?: string}>>}
 */
export async function probeNativeAddons({ importer = (specifier) => import(specifier), platform = process.platform, arch = process.arch } = {}) {
  const results = [];
  for (const name of NATIVE_ADDONS) {
    try {
      await importer(name);
      results.push({ name, ok: true });
    } catch (error) {
      results.push({ name, ok: false, package: platformPackageFor(name, { platform, arch }), error: errorText(error) });
    }
  }
  return results;
}
