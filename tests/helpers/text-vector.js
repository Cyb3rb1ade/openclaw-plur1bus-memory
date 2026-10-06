/**
 * tests/helpers/text-vector.js
 *
 * Text-dependent unit vector whose components are independent SHA-256 draws:
 * distinct texts are near-orthogonal (cosine ~ N(0, 1/sqrt(dim)); max 0.22 over
 * 100 000 random pairs at dim 384), identical texts are identical.
 *
 * Replaces the single-32-bit-FNV sawtooth `(hash + i*K) mod 2^32 mod 2000`: two
 * hashes whose difference was near a multiple of 2000 gave almost the same
 * vector, so ~0.1% of runs put an unrelated query within forgetThreshold 0.9 of
 * a deleted card (windows-2025 node 24.16.0, PR #235; fixed for
 * tombstone-query-recovery in #242).
 */

import { createHash } from "node:crypto";

/**
 * @param {unknown} text Input text.
 * @param {number} [dim] Vector length.
 * @returns {number[]} Unit vector of length `dim`.
 */
export function sha256TextVector(text, dim = 384) {
  const raw = [];
  for (let block = 0; raw.length < dim; block += 1) {
    const digest = createHash("sha256").update(`${block}\0${text}`).digest();
    for (let offset = 0; offset < digest.length && raw.length < dim; offset += 2) {
      raw.push(digest.readUInt16BE(offset) / 32767.5 - 1);
    }
  }
  const norm = Math.sqrt(raw.reduce((sum, v) => sum + v * v, 0)) || 1;
  return raw.map((v) => v / norm);
}
