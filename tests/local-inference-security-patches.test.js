import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { makeTempDir } from "./helpers/temp-dir.js";

const require = createRequire(import.meta.url);
const onnxRequire = createRequire(require.resolve("onnxruntime-node/package.json"));
const transformerRequire = createRequire(require.resolve("@huggingface/transformers"));

function attempt(operation) {
  try { return { value: operation() }; }
  catch (error) { return { error }; }
}

for (const route of ["extractEntryTo", "extractAllTo"]) {
  for (const link of ["file", "directory"]) {
    test(`adm-zip ${route} cannot overwrite through an existing ${link} symlink`, (t) => {
      const root = makeTempDir("plur1bus-zip-symlink-regression-");
      const destination = join(root, "destination");
      const outside = join(root, "outside");
      mkdirSync(destination); mkdirSync(outside);
      const victim = join(outside, "model.bin");
      writeFileSync(victim, "preserve-existing-data");
      const linked = attempt(() => link === "file"
        ? symlinkSync(victim, join(destination, "model.bin"), "file")
        : symlinkSync(outside, join(destination, "payload"), process.platform === "win32" ? "junction" : "dir"));
      if (process.platform === "win32" && ["EPERM", "EACCES"].includes(linked.error?.code)) {
        t.skip("Windows runner does not permit creating this symlink");
        return;
      }
      if (linked.error) throw linked.error;
      const AdmZip = onnxRequire("adm-zip");
      const zip = new AdmZip();
      const name = link === "file" ? "model.bin" : "payload/model.bin";
      zip.addFile(name, Buffer.from("must-not-escape"));
      // Refusal may throw or return false; neither may mutate the outside file.
      const result = attempt(() => route === "extractEntryTo"
        ? zip.extractEntryTo(zip.getEntry(name), destination, true, true)
        : zip.extractAllTo(destination, true));
      assert.ok(!result.error || result.error instanceof Error);
      assert.equal(readFileSync(victim, "utf8"), "preserve-existing-data");
    });
  }
}

test("patched sharp loads its native library and retains image-processing APIs", async () => {
  const sharp = transformerRequire("sharp");
  assert.equal(sharp.versions.sharp, "0.35.4");
  const buffer = await sharp({ create: { width: 2, height: 2, channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
  const metadata = await sharp(buffer).metadata();
  assert.equal(metadata.width, 2);
  assert.equal(metadata.height, 2);
  const resized = await sharp(buffer).resize(1, 1).raw().toBuffer({ resolveWithObject: true });
  assert.equal(resized.info.width, 1);
  assert.equal(resized.info.height, 1);
  const transformers = await import("@huggingface/transformers");
  assert.equal(typeof transformers.pipeline, "function");
});
