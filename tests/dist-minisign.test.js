import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";
import { parsePublicKey, verifyMinisign } from "../scripts/dist/minisign.mjs";
import { generateTestKeyPair } from "./helpers/minisign-sign.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = join(root, "tests", "fixtures", "minisign");
const modulePath = join(root, "scripts", "dist", "minisign.mjs");

const pubFile = readFileSync(join(fixtures, "test.pub"), "utf8");
const pubLine = pubFile.split("\n")[1];
const feed = readFileSync(join(fixtures, "feed.json"));
const legacySig = readFileSync(join(fixtures, "feed.json.minisig"), "utf8");
const prehashedSig = readFileSync(join(fixtures, "feed-prehashed.json.minisig"), "utf8");

const FIXTURES = [
  { name: "legacy (Ed)", sig: legacySig, trusted: "TEST ONLY plur1bus.plugin-feed/1 fixture (legacy)" },
  { name: "prehashed (ED)", sig: prehashedSig, trusted: "TEST ONLY plur1bus.plugin-feed/1 fixture (prehashed)" },
];

/** Replace line `index` (0-based) of a .minisig text. */
function withLine(sigText, index, fn) {
  const lines = sigText.split("\n");
  lines[index] = fn(lines[index]);
  return lines.join("\n");
}

function hasMinisignCli() {
  const r = spawnSync("minisign", ["-v"], { encoding: "utf8" });
  return r.status === 0;
}

describe("scripts/dist/minisign.mjs", () => {
  it("verifies the committed legacy and prehashed fixtures", () => {
    assert.match(pubFile.split("\n")[0], /^untrusted comment: TEST ONLY /);
    const publicKey = parsePublicKey(pubLine);
    assert.equal(publicKey.keyId.length, 8);
    assert.equal(publicKey.key.asymmetricKeyType, "ed25519");
    for (const f of FIXTURES) {
      assert.match(f.sig.split("\n")[0], /^untrusted comment: TEST ONLY /, f.name);
      assert.deepEqual(
        verifyMinisign({ message: feed, signatureText: f.sig, publicKey }),
        { ok: true, trustedComment: f.trusted },
        f.name,
      );
      // The public key may also be passed as its base64 line.
      assert.equal(verifyMinisign({ message: feed, signatureText: f.sig, publicKey: pubLine }).ok, true, f.name);
    }
    // CRLF line endings in the .minisig (a Windows download) still verify.
    assert.equal(
      verifyMinisign({ message: feed, signatureText: legacySig.replace(/\n/g, "\r\n"), publicKey }).ok,
      true,
    );
  });

  it("rejects a flipped message byte, a flipped trusted comment, another key id, and a truncated signature", () => {
    const publicKey = parsePublicKey(pubLine);
    const other = parsePublicKey(generateTestKeyPair().publicKeyLine);
    for (const f of FIXTURES) {
      const flipped = Buffer.from(feed);
      flipped[10] ^= 0x01;
      assert.deepEqual(
        verifyMinisign({ message: flipped, signatureText: f.sig, publicKey }),
        { ok: false, reason: "bad-signature" },
        `${f.name}: message byte`,
      );

      const tc = withLine(f.sig, 2, (l) => l.replace("TEST ONLY", "TEST 0NLY"));
      assert.deepEqual(
        verifyMinisign({ message: feed, signatureText: tc, publicKey }),
        { ok: false, reason: "bad-global-signature" },
        `${f.name}: trusted comment`,
      );

      assert.deepEqual(
        verifyMinisign({ message: feed, signatureText: f.sig, publicKey: other }),
        { ok: false, reason: "key-id-mismatch" },
        `${f.name}: key id`,
      );

      for (const truncated of [
        f.sig.slice(0, f.sig.length - 20),
        withLine(f.sig, 1, (l) => l.slice(0, 60)),
        f.sig.split("\n").slice(0, 2).join("\n"),
        "",
      ]) {
        assert.deepEqual(
          verifyMinisign({ message: feed, signatureText: truncated, publicKey }),
          { ok: false, reason: "malformed" },
          `${f.name}: truncated`,
        );
      }

      const alg = withLine(f.sig, 1, (l) => {
        const raw = Buffer.from(l, "base64");
        raw.write("EX", 0, "latin1");
        return raw.toString("base64");
      });
      assert.deepEqual(
        verifyMinisign({ message: feed, signatureText: alg, publicKey }),
        { ok: false, reason: "unsupported-algorithm" },
        `${f.name}: algorithm`,
      );
    }
    assert.throws(() => parsePublicKey("RWQ/azFL35Xv"), /public key/);
    assert.throws(() => parsePublicKey(Buffer.alloc(42).toString("base64")), /public key/);
    assert.deepEqual(
      verifyMinisign({ message: feed, signatureText: legacySig, publicKey: "not-a-key" }),
      { ok: false, reason: "malformed" },
    );
  });

  it("round-trips with the test signer for both algorithms", () => {
    const kp = generateTestKeyPair();
    const dir = makeTempDir("dist-minisign-");
    const cli = hasMinisignCli();
    for (const prehash of [false, true]) {
      const message = Buffer.from(`TEST ONLY ${prehash ? "prehashed" : "legacy"} message\n`);
      const sig = kp.sign(message, { prehash, trustedComment: "TEST ONLY round trip" });
      assert.equal(Buffer.from(sig.split("\n")[1], "base64").subarray(0, 2).toString("latin1"), prehash ? "ED" : "Ed");
      assert.deepEqual(verifyMinisign({ message, signatureText: sig, publicKey: kp.publicKeyLine }), {
        ok: true,
        trustedComment: "TEST ONLY round trip",
      });
      if (cli) {
        // The helper's output is accepted by the reference implementation too.
        const m = join(dir, `m-${prehash}`);
        writeFileSync(m, message);
        writeFileSync(`${m}.minisig`, sig);
        const r = spawnSync("minisign", ["-V", "-P", kp.publicKeyLine, "-m", m], { encoding: "utf8" });
        assert.equal(r.status, 0, r.stderr);
      }
    }
  });

  it("mainVerify exits 0 or 1 with the reason on stderr, from a file and inlined with -e", () => {
    const dir = makeTempDir("dist-minisign-cli-");
    const good = join(fixtures, "feed.json");
    const bad = join(dir, "feed.json");
    const tampered = Buffer.from(feed);
    tampered[20] ^= 0x01;
    writeFileSync(bad, tampered);
    const sigPath = join(fixtures, "feed-prehashed.json.minisig");

    const ok = spawnSync(process.execPath, [modulePath, pubLine, good, sigPath], { encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr);
    const ko = spawnSync(process.execPath, [modulePath, pubLine, bad, sigPath], { encoding: "utf8" });
    assert.equal(ko.status, 1);
    assert.match(ko.stderr, /bad-signature/);
    const usage = spawnSync(process.execPath, [modulePath, pubLine], { encoding: "utf8" });
    assert.equal(usage.status, 1);
    assert.match(usage.stderr, /usage/i);
    const missing = spawnSync(process.execPath, [modulePath, pubLine, join(dir, "nope"), sigPath], { encoding: "utf8" });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /unreadable/);

    // The bootstraps inline the module source and call mainVerify themselves.
    const source = readFileSync(modulePath, "utf8");
    const inline = `${source}\nprocess.exitCode = mainVerify(process.argv.slice(1));\n`;
    const a = spawnSync(process.execPath, ["--input-type=module", "-e", inline, pubLine, good, sigPath], { encoding: "utf8" });
    assert.equal(a.status, 0, a.stderr);
    const b = spawnSync(process.execPath, ["--input-type=module", "-e", inline, pubLine, bad, sigPath], { encoding: "utf8" });
    assert.equal(b.status, 1);
    assert.match(b.stderr, /bad-signature/);
  });

  it("the module imports only node:crypto and node:buffer", () => {
    const source = readFileSync(modulePath, "utf8");
    const specifiers = [
      ...source.matchAll(/^\s*import\s[^;]*?from\s*["']([^"']+)["']/gm),
      ...source.matchAll(/^\s*import\s*["']([^"']+)["']/gm),
      ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g),
      ...source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']/g),
    ].map((m) => m[1]);
    assert.ok(specifiers.length > 0);
    for (const s of specifiers) assert.ok(["node:crypto", "node:buffer"].includes(s), `unexpected import ${s}`);
    assert.doesNotMatch(source, /^\s*export\s+\*\s+from/m);
  });
});
