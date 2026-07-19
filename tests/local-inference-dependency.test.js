import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);

function versionAtLeast(actual, minimum) {
  const actualParts = String(actual).split(".").map(Number);
  const minimumParts = String(minimum).split(".").map(Number);
  for (let index = 0; index < Math.max(actualParts.length, minimumParts.length); index += 1) {
    const left = actualParts[index] ?? 0;
    const right = minimumParts[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

test("Local Inference resolves patched adm-zip with ONNX Runtime-compatible APIs", () => {
  const lockfile = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  const lockedVersion = lockfile.packages?.["node_modules/adm-zip"]?.version;
  const runtimeVersion = require("adm-zip/package.json").version;

  assert.ok(versionAtLeast(lockedVersion, "0.6.0"), `lockfile resolved vulnerable adm-zip ${lockedVersion}`);
  assert.ok(versionAtLeast(runtimeVersion, "0.6.0"), `installed adm-zip is vulnerable: ${runtimeVersion}`);

  const AdmZip = require("adm-zip");
  const archive = new AdmZip();
  archive.addFile("payload/model.bin", Buffer.from("local-inference-compatibility"));
  const reopened = new AdmZip(archive.toBuffer());
  const entry = reopened.getEntry("payload/model.bin");
  assert.ok(entry, "ONNX Runtime's constructor/getEntry path must remain available");
  assert.strictEqual(entry.getData().toString("utf8"), "local-inference-compatibility");

  const extractDir = mkdtempSync(join(tmpdir(), "plur1bus-adm-zip-"));
  try {
    reopened.extractEntryTo(entry, extractDir, false, true);
    assert.strictEqual(
      readFileSync(join(extractDir, "model.bin"), "utf8"),
      "local-inference-compatibility",
      "ONNX Runtime's extractEntryTo(entry, target, false, true) call must remain compatible",
    );
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
});
