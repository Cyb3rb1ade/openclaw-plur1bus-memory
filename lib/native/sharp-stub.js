/**
 * lib/native/sharp-stub.js — callable stand-in for `sharp` when the native
 * addon cannot load. Transformers.js (`@huggingface/transformers` 4.2.0)
 * statically imports `sharp` at module evaluation and branches on its
 * truthiness; a missing or failing addon must still yield a function so
 * text pipelines can load. Image calls throw with the reason code.
 *
 * No `api.` here (scripts/lint-no-api-outside-adapter.mjs).
 */

export const SHARP_UNAVAILABLE_REASON = "native_addon_unavailable:sharp";

/**
 * Throw the vision-degrade error for one sharp entry point.
 * @param {string} [method] Entry name for the message.
 * @returns {never}
 */
export function throwSharpUnavailable(method = "sharp") {
  const error = new Error(`${SHARP_UNAVAILABLE_REASON} (${method})`);
  error.code = "ERR_DLOPEN_FAILED";
  error.reason = SHARP_UNAVAILABLE_REASON;
  throw error;
}

function sharpStub(..._args) {
  throwSharpUnavailable("sharp()");
}

sharpStub.default = sharpStub;
sharpStub.versions = Object.freeze({ sharp: "unavailable", vips: "unavailable" });
sharpStub.cache = false;
sharpStub.concurrency = () => {
  throwSharpUnavailable("sharp.concurrency");
};
sharpStub.simd = () => false;
sharpStub.block = () => {
  throwSharpUnavailable("sharp.block");
};
sharpStub.counters = () => ({});
sharpStub.queue = () => 0;

export default sharpStub;
export { sharpStub };
