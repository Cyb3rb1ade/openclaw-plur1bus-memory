/**
 * lib/native/sharp-unavailable.js — probe `sharp`, and when it cannot load
 * intercept later imports so `@huggingface/transformers` can still evaluate
 * for text embedding. Vision APIs then throw `native_addon_unavailable:sharp`.
 *
 * `@huggingface/transformers` 4.2.0 does `import sharp from 'sharp'` from
 * `src/utils/image.js` at module load, so a failed native dlopen would
 * otherwise reject the whole transformers graph (and can surface as an
 * unhandled rejection). Text embedding does not need sharp.
 *
 * No `api.` here (scripts/lint-no-api-outside-adapter.mjs).
 */

import { createRequire, registerHooks } from "node:module";
import moduleLib from "node:module";

import { redactError, safeWarn } from "../safe-logging.js";
import sharpStub, { SHARP_UNAVAILABLE_REASON } from "./sharp-stub.js";

export { SHARP_UNAVAILABLE_REASON, throwSharpUnavailable } from "./sharp-stub.js";

const require = createRequire(import.meta.url);
const NodeModule = moduleLib.Module ?? moduleLib;
const STUB_URL = new URL("./sharp-stub.js", import.meta.url).href;

let stubInstalled = false;
let warned = false;

/**
 * Reason code for a native addon that did not load.
 * @param {string} name Addon package name (`sharp`, …).
 * @returns {string}
 */
export function nativeAddonUnavailableReason(name) {
  return `native_addon_unavailable:${name}`;
}

function isSharpRequest(request) {
  if (request === "sharp") return true;
  if (typeof request !== "string") return false;
  const normalized = request.replace(/\\/g, "/");
  return /(?:^|\/)node_modules\/sharp\/(?:lib\/)?index\.(?:cjs|js)$/.test(normalized)
    || /(?:^|\/)sharp\/lib\/index\.(?:cjs|js)$/.test(normalized);
}

/**
 * Whether the process-wide sharp stub is already intercepting imports.
 * @returns {boolean}
 */
export function sharpStubInstalled() {
  return stubInstalled;
}

/**
 * Replace later `sharp` imports with the vision-degrade stub.
 *
 * Safe to call more than once. Call only after a real `sharp` load has
 * already failed: a successful load must keep the native module.
 * @returns {void}
 */
export function installSharpUnavailableStub() {
  if (stubInstalled) return;

  const originalLoad = NodeModule._load;
  NodeModule._load = function plur1busSharpUnavailableLoad(request, parent, isMain) {
    if (isSharpRequest(request)) return sharpStub;
    return originalLoad.call(this, request, parent, isMain);
  };

  const cache = NodeModule._cache;
  if (cache && typeof cache === "object") {
    for (const filename of Object.keys(cache)) {
      if (isSharpRequest(filename)) delete cache[filename];
    }
  }

  if (typeof registerHooks === "function") {
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "sharp") {
          return { url: STUB_URL, shortCircuit: true, format: "module" };
        }
        return nextResolve(specifier, context);
      },
    });
  }

  stubInstalled = true;
}

/**
 * Load `sharp` through the CJS resolver so a failure does not poison the
 * ESM module map that `@huggingface/transformers` later uses.
 * @param {{importer?: (specifier: string) => Promise<unknown>|unknown}} [options]
 * @returns {Promise<{ok: true}|{ok: false, error: unknown}>}
 */
export async function probeSharpLoad({ importer } = {}) {
  try {
    const loaded = importer ? await importer("sharp") : require("sharp");
    if (loaded == null) {
      return { ok: false, error: new Error("sharp resolved to empty") };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * One redacted warning with `native_addon_unavailable:sharp`.
 * @param {object|null|undefined} logger Optional logger (`safeWarn`).
 * @param {unknown} error The load failure.
 * @returns {void}
 */
export function warnSharpUnavailable(logger, error) {
  if (warned) return;
  warned = true;
  const redacted = redactError(error);
  safeWarn(logger, "native", redacted.message, { reason: SHARP_UNAVAILABLE_REASON });
}

/**
 * Probe `sharp`, install the stub when it cannot load, then import transformers.
 * @param {object} [options]
 * @param {() => Promise<unknown>} [options.importer] Transformers loader.
 * @param {(specifier: string) => Promise<unknown>|unknown} [options.sharpImporter]
 * @param {object|null} [options.logger]
 * @returns {Promise<unknown>}
 */
export async function importTransformersBehindSharpProbe({
  importer = () => import("@huggingface/transformers"),
  sharpImporter,
  logger,
} = {}) {
  const probe = await probeSharpLoad(sharpImporter ? { importer: sharpImporter } : {});
  if (!probe.ok) {
    installSharpUnavailableStub();
    warnSharpUnavailable(logger, probe.error);
  }
  return importer();
}
