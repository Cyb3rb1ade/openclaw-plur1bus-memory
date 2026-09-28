/**
 * scripts/dist/minisign.mjs — zero-dependency minisign signature verifier.
 *
 * Verifies `.minisig` files produced by `minisign -S` (legacy "Ed": Ed25519
 * over the message; prehashed "ED", the default since minisign 0.8: Ed25519
 * over BLAKE2b-512(message)), then the global signature over
 * sig[64] || trustedComment. Used by the plugin bootstraps to check the
 * signed plugin feed before trusting any URL or hash in it (HM1-R3).
 *
 * Constraints: this file stays self-contained and imports only node:crypto and
 * node:buffer, because the bootstraps inline its source and run it with
 * `node --input-type=module -e` (tests/dist-minisign.test.js scans the import
 * lines). The CLI entry reads files through process.getBuiltinModule so that
 * the module has no further import.
 *
 * CLI: node minisign.mjs <pubkey-line> <file> <sig-file>
 *      exit 0 when valid (trusted comment on stdout), 1 otherwise (reason on stderr).
 */

import { createHash, createPublicKey, verify } from "node:crypto";
import { Buffer } from "node:buffer";

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const UNTRUSTED_PREFIX = "untrusted comment:";
const TRUSTED_PREFIX = "trusted comment: ";

/** Strict base64 decode: returns null unless `text` is canonical base64 of exactly `length` bytes. */
function decodeBase64(text, length) {
  if (typeof text !== "string" || !B64.test(text)) return null;
  const raw = Buffer.from(text, "base64");
  if (raw.length !== length || raw.toString("base64") !== text) return null;
  return raw;
}

/**
 * Parse a minisign public key: the second line of a `.pub` file,
 * base64("Ed" | keyId[8] | pk[32]).
 * @param {string} line
 * @returns {{keyId: Buffer, key: import("node:crypto").KeyObject}}
 */
export function parsePublicKey(line) {
  const raw = decodeBase64(typeof line === "string" ? line.trim() : "", 42);
  if (!raw || raw[0] !== 0x45 || raw[1] !== 0x64) {
    throw new Error("invalid minisign public key: expected base64 of \"Ed\" | keyId[8] | pk[32]");
  }
  const key = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: raw.subarray(10, 42).toString("base64url") },
    format: "jwk",
  });
  return { keyId: Buffer.from(raw.subarray(2, 10)), key };
}

/**
 * Verify a minisign signature.
 * @param {{ message: Buffer | Uint8Array | string, signatureText: string, publicKey: string | {keyId: Buffer, key: import("node:crypto").KeyObject} }} args
 * @returns {{ok: true, trustedComment: string} | {ok: false, reason: "malformed"|"unsupported-algorithm"|"key-id-mismatch"|"bad-signature"|"bad-global-signature"}}
 */
export function verifyMinisign({ message, signatureText, publicKey }) {
  let pk = publicKey;
  if (typeof pk === "string") {
    try {
      pk = parsePublicKey(pk);
    } catch {
      return { ok: false, reason: "malformed" };
    }
  }
  if (!pk || !Buffer.isBuffer(pk.keyId) || pk.keyId.length !== 8 || !pk.key) {
    return { ok: false, reason: "malformed" };
  }
  if (typeof signatureText !== "string") return { ok: false, reason: "malformed" };

  const lines = signatureText.replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 4 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length !== 4) return { ok: false, reason: "malformed" };
  const [untrusted, sigLine, trustedLine, globalLine] = lines;
  if (!untrusted.startsWith(UNTRUSTED_PREFIX) || !trustedLine.startsWith(TRUSTED_PREFIX)) {
    return { ok: false, reason: "malformed" };
  }
  const sigRaw = decodeBase64(sigLine, 74);
  const globalSig = decodeBase64(globalLine, 64);
  if (!sigRaw || !globalSig) return { ok: false, reason: "malformed" };

  const alg = sigRaw.subarray(0, 2).toString("latin1");
  if (alg !== "Ed" && alg !== "ED") return { ok: false, reason: "unsupported-algorithm" };
  if (!sigRaw.subarray(2, 10).equals(pk.keyId)) return { ok: false, reason: "key-id-mismatch" };

  const sig = sigRaw.subarray(10, 74);
  const msg = typeof message === "string" ? Buffer.from(message, "utf8") : Buffer.from(message);
  const signed = alg === "ED" ? createHash("blake2b512").update(msg).digest() : msg;
  if (!verify(null, signed, pk.key, sig)) return { ok: false, reason: "bad-signature" };

  const trustedComment = trustedLine.slice(TRUSTED_PREFIX.length);
  const globalMsg = Buffer.concat([sig, Buffer.from(trustedComment, "utf8")]);
  if (!verify(null, globalMsg, pk.key, globalSig)) return { ok: false, reason: "bad-global-signature" };

  return { ok: true, trustedComment };
}

/**
 * CLI: verify <file> against <sig-file> with <pubkey-line>.
 * @param {string[]} argv  [pubkeyLine, file, sigFile]
 * @returns {0 | 1} exit code; the reason goes to stderr
 */
export function mainVerify(argv) {
  if (!Array.isArray(argv) || argv.length !== 3) {
    process.stderr.write("usage: node minisign.mjs <pubkey-line> <file> <sig-file>\n");
    return 1;
  }
  const [pubkeyLine, file, sigFile] = argv;
  const fs = process.getBuiltinModule("node:fs");
  let message;
  let signatureText;
  try {
    message = fs.readFileSync(file);
    signatureText = fs.readFileSync(sigFile, "utf8");
  } catch (err) {
    process.stderr.write(`minisign: unreadable input (${err && err.code ? err.code : "error"})\n`);
    return 1;
  }
  const res = verifyMinisign({ message, signatureText, publicKey: pubkeyLine });
  if (!res.ok) {
    process.stderr.write(`minisign: signature verification failed: ${res.reason}\n`);
    return 1;
  }
  process.stdout.write(`${res.trustedComment}\n`);
  return 0;
}

// Run as a script only (`node minisign.mjs …`); inlined with -e, import.meta.filename is undefined.
if (import.meta.filename && process.argv[1] === import.meta.filename) {
  process.exitCode = mainVerify(process.argv.slice(2));
}
