// tests/dist-hermes-untar.test.js — the installer's strict provider-tarball reader (HM2-R21) against the real
// Task 7 tarball and hand-made hostile archives. Never touches anything outside a temp dir.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";

import { extractTarGz, UntarError } from "../scripts/dist/installer/untar.mjs";
import { checkProviderDir } from "../scripts/dist/installer/hermes/provider.mjs";
import { PROVIDER_TARBALL } from "./helpers/hermes-sandbox.js";
import { makeTar, makeTarGz } from "./helpers/ustar.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const sha256 = (b) => createHash("sha256").update(b).digest("hex");

async function refuses(entries, code, opts = {}) {
  const dir = makeTempDir("hermes-untar-");
  const file = join(dir, "t.tar.gz");
  writeFileSync(file, Buffer.isBuffer(entries) ? entries : makeTarGz(entries));
  const dest = join(dir, "out");
  await assert.rejects(extractTarGz({ file, dest, ...opts }), (err) => {
    assert.ok(err instanceof UntarError, String(err));
    assert.equal(err.code, code, err.message);
    return true;
  });
  assert.equal(existsSync(dest), false, "nothing is written when the archive is refused");
}

describe("hermes installer: untar", () => {
  it("extracts the Task 7 fixture tarball", async () => {
    const dir = makeTempDir("hermes-untar-");
    const dest = join(dir, "out");
    const { files, dirs } = await extractTarGz({ file: PROVIDER_TARBALL, dest });
    assert.ok(files.includes("plur1bus/__init__.py"));
    assert.ok(files.includes("plur1bus/_vendor/plur1bus_memory_client/client.py"));
    assert.ok(dirs.includes("plur1bus"));
    // the fixture is checked by its MANIFEST.json, not by the gzip hash (T7 review: zlib output may differ)
    const manifestBytes = readFileSync(join(dest, "plur1bus", "MANIFEST.json"));
    const sources = JSON.parse(readFileSync(join(dirname(PROVIDER_TARBALL), "SOURCES.json"), "utf8"));
    assert.equal(sha256(manifestBytes), sources.providerTarball.manifestSha256, "the fixture is the pinned provider build (rebuild with the harness script and update SOURCES.json)");
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    assert.equal(manifest.schema, "plur1bus.hermes-provider/1");
    assert.equal(manifest.version, "0.1.0");
    assert.deepEqual(Object.keys(manifest.files).sort(), files.filter((f) => f !== "plur1bus/MANIFEST.json").sort());
    for (const [p, h] of Object.entries(manifest.files)) assert.equal(sha256(readFileSync(join(dest, ...p.split("/")))), h, p);
    assert.deepEqual(checkProviderDir(join(dest, "plur1bus"), { version: "0.1.0" }).ok, true);
    if (process.platform !== "win32") {
      assert.equal(statSync(join(dest, "plur1bus", "__init__.py")).mode & 0o777, 0o644);
      assert.equal(statSync(join(dest, "plur1bus", "_vendor")).mode & 0o777, 0o755);
    }
  });

  it("refuses symlinks, absolute paths, .. and case-fold duplicates", async () => {
    await refuses([{ name: "plur1bus/", type: "5" }, { name: "plur1bus/link", type: "2", linkname: "/etc/passwd" }], "unsafe-entry");
    await refuses([{ name: "plur1bus/hard", type: "1", linkname: "plur1bus/x" }], "unsafe-entry");
    await refuses([{ name: "/etc/x", data: "x" }], "unsafe-entry");
    await refuses([{ name: "C:/x", data: "x" }], "unsafe-entry");
    await refuses([{ name: "../x", data: "x" }], "unsafe-entry");
    await refuses([{ name: "plur1bus/../../x", data: "x" }], "unsafe-entry");
    await refuses([{ name: "plur1bus\\..\\x", data: "x" }], "unsafe-entry");
    await refuses([{ name: "plur1bus/./x", data: "x" }], "unsafe-entry");
    await refuses([{ name: "x", prefix: "..", data: "x" }], "unsafe-entry");
    await refuses([{ name: "pax", type: "x", data: "30 path=plur1bus/../../evil\n" }, { name: "plur1bus/ok", data: "x" }], "unsafe-entry");
    await refuses([{ name: "plur1bus/fifo", type: "6" }], "unsafe-entry");
    await refuses([{ name: "plur1bus/a.py", data: "1" }, { name: "plur1bus/A.py", data: "2" }], "duplicate");
    await refuses([{ name: "plur1bus/a.py", data: "1" }, { name: "plur1bus/a.py", data: "2" }], "duplicate");
    await refuses([{ name: "plur1bus/f", data: "1" }, { name: "plur1bus/f/g", data: "2" }], "unsafe-entry");
  });

  it("refuses more than maxBytes, and corrupt archives", async () => {
    const big = Buffer.alloc(4096, 0x61);
    await refuses([{ name: "plur1bus/big", data: big }], "too-large", { maxBytes: 1024 });
    // a gzip bomb stops while inflating
    await refuses(gzipSync(Buffer.alloc(8 << 20, 0)), "too-large", { maxBytes: 1 << 20 });
    await refuses(Buffer.from("not a gzip stream"), "corrupt");
    const tar = makeTar([{ name: "plur1bus/x", data: "hello" }]);
    tar[0] ^= 0x01; // the header checksum no longer matches
    await refuses(gzipSync(tar), "corrupt");
    const truncated = makeTar([{ name: "plur1bus/x", data: Buffer.alloc(2048, 1) }]).subarray(0, 1024);
    await refuses(gzipSync(truncated), "corrupt");
  });

  it("never writes into an existing destination", async () => {
    const dir = makeTempDir("hermes-untar-");
    await assert.rejects(extractTarGz({ file: PROVIDER_TARBALL, dest: dir }), (e) => e.code === "unsafe-entry");
  });
});
