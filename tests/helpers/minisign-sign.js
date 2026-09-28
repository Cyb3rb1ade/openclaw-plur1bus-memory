/**
 * tests/helpers/minisign-sign.js — TEST ONLY minisign signer.
 *
 * Generates an ephemeral Ed25519 key pair per call (never written to disk,
 * never committed) and produces `.minisig` text in minisign's format, legacy
 * ("Ed", Ed25519 over the message) or prehashed ("ED", Ed25519 over
 * BLAKE2b-512(message)). Real release keys are held offline by the owner
 * (HM1-R4); nothing here may ever sign a published feed.
 */

import { createHash, generateKeyPairSync, randomBytes, sign as edSign } from "node:crypto";
import { Buffer } from "node:buffer";

const UNTRUSTED = "TEST ONLY minisign key, generated per test run";

/**
 * @returns {{
 *   keyId: Buffer,
 *   publicKeyLine: string,
 *   publicKeyFile: string,
 *   sign: (message: Buffer | string, opts?: { prehash?: boolean, trustedComment?: string, untrustedComment?: string }) => string,
 * }}
 */
export function generateTestKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pk = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const keyId = randomBytes(8);
  const publicKeyLine = Buffer.concat([Buffer.from("Ed"), keyId, pk]).toString("base64");
  const publicKeyFile = `untrusted comment: ${UNTRUSTED}\n${publicKeyLine}\n`;

  function sign(message, opts = {}) {
    const prehash = opts.prehash ?? true;
    const trustedComment = opts.trustedComment ?? `timestamp:${Math.floor(Date.now() / 1000)}\tfile:TEST-ONLY`;
    const untrustedComment = opts.untrustedComment ?? UNTRUSTED;
    const msg = Buffer.isBuffer(message) ? message : Buffer.from(message);
    const signed = prehash ? createHash("blake2b512").update(msg).digest() : msg;
    const sig = edSign(null, signed, privateKey);
    const globalSig = edSign(null, Buffer.concat([sig, Buffer.from(trustedComment, "utf8")]), privateKey);
    const sigLine = Buffer.concat([Buffer.from(prehash ? "ED" : "Ed"), keyId, sig]).toString("base64");
    return (
      `untrusted comment: ${untrustedComment}\n` +
      `${sigLine}\n` +
      `trusted comment: ${trustedComment}\n` +
      `${globalSig.toString("base64")}\n`
    );
  }

  return { keyId, publicKeyLine, publicKeyFile, sign };
}
