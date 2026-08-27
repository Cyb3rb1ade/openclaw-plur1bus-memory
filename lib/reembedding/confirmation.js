import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";

const PLAN_DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const TOKEN_HASH_RE = /^[a-f0-9]{64}$/;
const TOKEN_PREFIX = "reemb_v1_";

function confirmationHash(token, planDigest) {
  return createHash("sha256")
    .update("plur1bus-reembedding-confirmation:v1\0")
    .update(planDigest)
    .update("\0")
    .update(token)
    .digest("hex");
}

/** Create a one-time operator confirmation while persisting only its hash. */
export function createMigrationConfirmation({
  planDigest,
  expiresAt,
  randomBytes = nodeRandomBytes,
} = {}) {
  if (typeof planDigest !== "string" || !PLAN_DIGEST_RE.test(planDigest)) {
    throw new Error("invalid reembedding plan digest");
  }
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) throw new Error("invalid reembedding confirmation expiry");
  if (typeof randomBytes !== "function") throw new Error("reembedding confirmation entropy source is required");
  const entropy = randomBytes(32);
  if (!Buffer.isBuffer(entropy) || entropy.length !== 32) throw new Error("invalid reembedding confirmation entropy");
  const token = `${TOKEN_PREFIX}${entropy.toString("base64url")}`;
  return Object.freeze({
    token,
    persisted: Object.freeze({
      schemaVersion: 1,
      tokenHash: confirmationHash(token, planDigest),
      planDigest,
      expiresAt,
    }),
  });
}

/** Verify a confirmation without exposing which binding failed. */
export function verifyMigrationConfirmation(token, persisted, now = Date.now()) {
  if (
    typeof token !== "string"
    || !token.startsWith(TOKEN_PREFIX)
    || !persisted
    || typeof persisted !== "object"
    || persisted.schemaVersion !== 1
    || typeof persisted.planDigest !== "string"
    || !PLAN_DIGEST_RE.test(persisted.planDigest)
    || typeof persisted.tokenHash !== "string"
    || !TOKEN_HASH_RE.test(persisted.tokenHash)
    || !Number.isSafeInteger(persisted.expiresAt)
    || !Number.isSafeInteger(now)
    || now >= persisted.expiresAt
  ) return false;
  const expected = Buffer.from(persisted.tokenHash, "hex");
  const actual = Buffer.from(confirmationHash(token, persisted.planDigest), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
