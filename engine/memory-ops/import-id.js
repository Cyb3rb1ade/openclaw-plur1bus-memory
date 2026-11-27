/**
 * engine/memory-ops/import-id.js — deterministic card ids for `memory.import`
 * (contract 1.11.0). RFC 4122 UUID version 5 over `agentId` and the caller's
 * idempotency key, in the 36-character store format `safeUuid` accepts.
 *
 * Looking the card up by this id in the store is the source of truth. The
 * sidecar ledger is provenance display and a cache; a crash between `store()`
 * and the ledger line then resumes as `matched-existing`, not a second row.
 */

import { createHash } from "node:crypto";

/** URL namespace from RFC 4122 appendix C; name below is the import tuple. */
const RFC4122_URL_NAMESPACE = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

function uuidBytes(uuid) {
  const hex = String(uuid).replace(/-/g, "");
  return Buffer.from(hex, "hex");
}

function formatUuid(bytes) {
  const hex = Buffer.from(bytes).subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * RFC 4122 UUID v5 (SHA-1, version 5, RFC 4122 variant).
 * @param {string} name
 * @param {string} namespaceUuid
 * @returns {string}
 */
export function uuidv5(name, namespaceUuid) {
  const hash = createHash("sha1")
    .update(uuidBytes(namespaceUuid))
    .update(String(name), "utf8")
    .digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  return formatUuid(hash);
}

/**
 * @param {string} agentId
 * @param {string} idempotencyKey
 * @returns {string} 36-character lowercase UUID
 */
export function importCardId(agentId, idempotencyKey) {
  return uuidv5(`${agentId}\0${idempotencyKey}`, RFC4122_URL_NAMESPACE);
}
