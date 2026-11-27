/**
 * lib/native/sharp-unavailable.js — probe `sharp`, and when it cannot load
 * intercept later imports *from `@huggingface/transformers`* so that package
 * can still evaluate for text embedding. Vision APIs then throw
 * `native_addon_unavailable:sharp`. Imports of `sharp` from anywhere else
 * keep the real module.
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
import { fileURLToPath } from "node:url";

import { safeWarn } from "../safe-logging.js";
import sharpStub, { SHARP_UNAVAILABLE_REASON } from "./sharp-stub.js";

export { SHARP_UNAVAILABLE_REASON, throwSharpUnavailable } from "./sharp-stub.js";

const require = createRequire(import.meta.url);
const NodeModule = moduleLib.Module ?? moduleLib;
const STUB_URL = new URL("./sharp-stub.js", import.meta.url).href;
const TRANSFORMERS_DIR = "/node_modules/@huggingface/transformers/";

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

function callerPath(parentOrUrl) {
  if (typeof parentOrUrl === "string") return parentOrUrl;
  if (parentOrUrl && typeof parentOrUrl === "object") {
    if (typeof parentOrUrl.filename === "string") return parentOrUrl.filename;
    if (typeof parentOrUrl.id === "string") return parentOrUrl.id;
    if (typeof parentOrUrl.parentURL === "string") return parentOrUrl.parentURL;
  }
  return "";
}

/**
 * True when the importing file lives under `node_modules/@huggingface/transformers/`.
 * @param {string|object|null|undefined} parentOrUrl `Module` parent, filename, or `parentURL`.
 * @returns {boolean}
 */
export function isTransformersSharpCaller(parentOrUrl) {
  let value = callerPath(parentOrUrl);
  if (value.length === 0) return false;
  if (/^file:/i.test(value)) {
    try {
      value = fileURLToPath(value);
    } catch {
      try {
        value = decodeURIComponent(value.replace(/^file:\/\//i, ""));
      } catch {
        return false;
      }
    }
  }
  const normalized = value.replace(/\\/g, "/");
  return normalized.includes(TRANSFORMERS_DIR);
}

/**
 * Whether the process-wide sharp stub is already intercepting imports.
 * @returns {boolean}
 */
export function sharpStubInstalled() {
  return stubInstalled;
}

/**
 * Replace later `sharp` imports *from `@huggingface/transformers`* with the
 * vision-degrade stub. Other callers keep the real `sharp` module.
 *
 * Safe to call more than once. Call only after a real `sharp` load has
 * already failed: a successful load must keep the native module. The CJS
 * module cache is left alone unless this interceptor inserted the entry.
 * @returns {void}
 */
export function installSharpUnavailableStub() {
  if (stubInstalled) return;

  const originalLoad = NodeModule._load;
  NodeModule._load = function plur1busSharpUnavailableLoad(request, parent, isMain) {
    if (isSharpRequest(request) && isTransformersSharpCaller(parent)) {
      // Return the placeholder without writing Module._cache. Real `sharp`
      // entries that another caller already loaded stay untouched.
      return sharpStub;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  if (typeof registerHooks === "function") {
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "sharp" && isTransformersSharpCaller(context?.parentURL ?? context)) {
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
  safeWarn(logger, "native", error, { reason: SHARP_UNAVAILABLE_REASON });
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
