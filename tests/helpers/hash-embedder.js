/**
 * tests/helpers/hash-embedder.js — the deterministic text-hash embedder of the
 * capture replay tests (E4 Task 5), shared with the crash child
 * (tests/fixtures/capture-crash-child.mjs) so both processes embed alike:
 * equal texts give equal vectors, different texts give (practically)
 * orthogonal ones.
 */

function textHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * 384 dims, v[i] = ±1 from bit (i % 24) of the text hash, normalised.
 * @param {string} text
 * @returns {number[]}
 */
export function hashVector(text) {
  const h = textHash(String(text));
  const scale = 1 / Math.sqrt(384);
  return Array.from({ length: 384 }, (_, i) => (((h >>> (i % 24)) & 1) ? scale : -scale));
}

/**
 * `down = true` makes every capture-side embed call throw (embedder down);
 * `holdBatch = true` parks the next embedBatch until `release()`.
 * @returns {object} an embeddings provider for `testOptions.internals.embeddings`
 */
export function hashEmbedder() {
  const stub = {
    down: false,
    holdBatch: false,
    release: null,
    onHeld: null,
    embed: async (text) => { gate(); return hashVector(text); },
    embedQuery: async (text) => hashVector(text),
    embedPassage: async (text) => hashVector(text),
    embedBatch: async (texts) => {
      gate();
      if (stub.holdBatch) await new Promise((resolve) => { stub.release = resolve; stub.onHeld?.(); });
      return texts.map(hashVector);
    },
    shutdown: async () => {},
  };
  const gate = () => {
    if (stub.down) throw new Error("embedder unavailable (synthetic)");
  };
  return stub;
}
