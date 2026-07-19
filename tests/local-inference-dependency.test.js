import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
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
  const onnxPackagePath = require.resolve("onnxruntime-node/package.json");
  const onnxRequire = createRequire(onnxPackagePath);
  const admZipPackagePath = onnxRequire.resolve("adm-zip/package.json");
  const projectRoot = fileURLToPath(new URL("..", import.meta.url));
  const lockPackagePath = relative(projectRoot, dirname(admZipPackagePath)).replaceAll("\\", "/");
  const lockedVersion = lockfile.packages?.[lockPackagePath]?.version;
  const runtimeVersion = onnxRequire("adm-zip/package.json").version;

  assert.ok(
    versionAtLeast(lockedVersion, "0.6.0"),
    `onnxruntime-node lock path ${lockPackagePath} resolved vulnerable adm-zip ${lockedVersion}`,
  );
  assert.ok(
    versionAtLeast(runtimeVersion, "0.6.0"),
    `onnxruntime-node resolved vulnerable adm-zip ${runtimeVersion} from ${admZipPackagePath}`,
  );

  const AdmZip = onnxRequire("adm-zip");
  const archive = new AdmZip();
  archive.addFile("payload/model.bin", Buffer.from("local-inference-compatibility"));
  const tempRoot = mkdtempSync(join(tmpdir(), "plur1bus-adm-zip-"));
  const packagePath = join(tempRoot, "local-inference-runtime.nupkg");
  const extractDir = join(tempRoot, "extracted");
  try {
    writeFileSync(packagePath, archive.toBuffer());
    const reopened = new AdmZip(packagePath);
    const entry = reopened.getEntry("payload/model.bin");
    assert.ok(entry, "ONNX Runtime's filesystem constructor/getEntry path must remain available");
    assert.strictEqual(entry.getData().toString("utf8"), "local-inference-compatibility");
    reopened.extractEntryTo(entry, extractDir, false, true);
    assert.strictEqual(
      readFileSync(join(extractDir, "model.bin"), "utf8"),
      "local-inference-compatibility",
      "ONNX Runtime's extractEntryTo(entry, target, false, true) call must remain compatible",
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
