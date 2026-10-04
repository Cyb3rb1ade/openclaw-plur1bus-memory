/**
 * tests/selftest-sharp-degrade.test.js — sharp must not take down selftest.
 *
 * `@huggingface/transformers` imports `sharp` at module load. When the native
 * addon throws ERR_DLOPEN_FAILED, vision degrades with
 * `native_addon_unavailable:sharp`, text embed/capture/recall stay ok, and
 * there is no unhandledRejection.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import moduleLib, { createRequire } from "node:module";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import {
  SHARP_UNAVAILABLE_REASON,
  importTransformersBehindSharpProbe,
  installSharpUnavailableStub,
  isTransformersSharpCaller,
  sharpStubInstalled,
} from "../lib/native/sharp-unavailable.js";
import { throwSharpUnavailable } from "../lib/native/sharp-stub.js";
import { SELFTEST_SCHEMA, runSelftest } from "../lib/selftest/run-selftest.js";
import { makeTempDir } from "./helpers/temp-dir.js";

function histogramEmbedder(calls = []) {
  const vector = (text) => {
    const v = new Array(384).fill(0);
    for (const ch of String(text)) v[ch.charCodeAt(0) % 384] += 1;
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  };
  const record = (kind) => async (text) => { calls.push(kind); return vector(text); };
  return {
    embed: record("embed"),
    embedQuery: record("query"),
    embedPassage: record("passage"),
    embedBatch: async (texts) => texts.map(vector),
    shutdown: async () => {},
  };
}

function sandbox(label = "st-sharp-") {
  const root = makeTempDir(label);
  const stateDir = join(root, "state");
  const openclawHome = join(root, "oc-home");
  const homeDir = join(root, "home");
  for (const dir of [stateDir, openclawHome, homeDir]) mkdirSync(dir, { recursive: true });
  return { root, stateDir, openclawHome, homeDir, env: { OPENCLAW_HOME: openclawHome } };
}

const presentModels = () => ({
  validate: async () => ({ ok: true, artifacts: [] }),
  ensure: async () => ({ downloaded: 0, reused: 1 }),
});

function stepOf(report, id) {
  const step = report.steps.find((entry) => entry.id === id);
  assert.ok(step, `step ${id} is reported`);
  return step;
}

function dlopenError() {
  const error = new Error("The module '/tmp/sharp.node' failed: libvips-cpp.so.8.17.3: cannot open shared object file");
  error.code = "ERR_DLOPEN_FAILED";
  return error;
}

function sharpVersion(mod) {
  return (mod?.default ?? mod)?.versions?.sharp;
}

function sharpCacheKeys() {
  const cache = (moduleLib.Module ?? moduleLib)._cache ?? {};
  return Object.keys(cache)
    .filter((key) => key.replace(/\\/g, "/").includes("/node_modules/sharp/"))
    .sort();
}

async function withUnhandledRejectionGuard(body) {
  const rejections = [];
  const onUnhandled = (reason) => { rejections.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const result = await body();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(rejections.length, 0, `unhandledRejection: ${String(rejections[0])}`);
    return result;
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
}

describe("selftest sharp degrade", () => {
  it("ERR_DLOPEN_FAILED on sharp degrades vision and keeps text embed/capture/recall", async () => {
    const report = await withUnhandledRejectionGuard(async () => {
      const box = sandbox();
      const importer = async (specifier) => {
        if (specifier === "sharp") throw dlopenError();
        return {};
      };
      return runSelftest({
        stateDir: box.stateDir,
        env: box.env,
        homeDir: box.homeDir,
        importer,
        modelArtifacts: presentModels(),
        engineInternals: { embeddings: histogramEmbedder() },
      });
    });

    assert.equal(report.schema, SELFTEST_SCHEMA);
    assert.equal(report.ok, true, report.errors.join("; "));
    const sharp = report.addons.find((addon) => addon.name === "sharp");
    assert.equal(sharp.ok, false);
    assert.match(sharp.error, /libvips-cpp|ERR_DLOPEN_FAILED|cannot open shared object/);
    assert.equal(report.warnings.includes(SHARP_UNAVAILABLE_REASON), true);
    assert.equal(report.errors.some((entry) => /sharp/i.test(entry)), false);
    const vision = report.capabilities.find((capability) => capability.id === "vision");
    assert.deepEqual(vision, { id: "vision", status: "degraded", reason: SHARP_UNAVAILABLE_REASON });
    for (const id of ["embed", "capture", "recall"]) {
      assert.equal(stepOf(report, id).ok, true, `${id}: ${stepOf(report, id).detail}`);
      assert.equal(stepOf(report, id).skipped, undefined, id);
    }
  });

  it("a working sharp probe leaves vision ok", async () => {
    const box = sandbox();
    const report = await runSelftest({
      stateDir: box.stateDir,
      env: box.env,
      homeDir: box.homeDir,
      importer: async () => ({}),
      modelArtifacts: presentModels(),
      engineInternals: { embeddings: histogramEmbedder() },
    });
    assert.equal(report.ok, true, report.errors.join("; "));
    assert.deepEqual(report.capabilities, [{ id: "vision", status: "ok" }]);
    assert.equal(report.warnings.includes(SHARP_UNAVAILABLE_REASON), false);
  });

  it("lancedb failure still fails the selftest when sharp is also missing", async () => {
    const box = sandbox();
    const importer = async (specifier) => {
      if (specifier === "@lancedb/lancedb") throw new Error("Cannot find module '@lancedb/lancedb-linux-x64-gnu'");
      if (specifier === "sharp") throw dlopenError();
      return {};
    };
    const report = await runSelftest({
      stateDir: box.stateDir,
      env: box.env,
      homeDir: box.homeDir,
      importer,
      modelArtifacts: presentModels(),
      engineInternals: { embeddings: histogramEmbedder() },
    });
    assert.equal(report.ok, false);
    assert.match(report.errors[0], /@lancedb\/lancedb/);
    assert.equal(report.errors.some((entry) => /sharp/i.test(entry)), false);
    assert.equal(report.warnings.includes(SHARP_UNAVAILABLE_REASON), true);
  });

  it("the sharp stub throws the reason code and is not a thenable", () => {
    assert.equal(typeof throwSharpUnavailable, "function");
    assert.throws(() => throwSharpUnavailable("sharp()"), (error) => {
      assert.equal(error.reason, SHARP_UNAVAILABLE_REASON);
      assert.equal(error.code, "ERR_DLOPEN_FAILED");
      assert.match(error.message, /native_addon_unavailable:sharp/);
      return true;
    });
  });

  it("imports of sharp from outside transformers stay the real module after the stub is installed", async () => {
    const req = createRequire(import.meta.url);
    const cjs = req("sharp");
    assert.notEqual(sharpVersion(cjs), "unavailable");
    const keysBefore = sharpCacheKeys();
    assert.ok(keysBefore.length > 0, "real sharp is in Module._cache");

    installSharpUnavailableStub();
    assert.equal(sharpStubInstalled(), true);
    assert.deepEqual(sharpCacheKeys(), keysBefore);

    const cjsAfter = req("sharp");
    const esm = await import("sharp");
    assert.equal(cjsAfter, cjs);
    assert.notEqual(sharpVersion(cjsAfter), "unavailable");
    assert.notEqual(sharpVersion(esm), "unavailable");
    assert.doesNotThrow(() => { cjsAfter(); });
  });

  it("transformers import after a failed sharp probe uses the stub and does not reject", async () => {
    const transformers = await withUnhandledRejectionGuard(async () => {
      return importTransformersBehindSharpProbe({
        sharpImporter: async () => { throw dlopenError(); },
      });
    });
    assert.equal(sharpStubInstalled(), true);
    assert.equal(typeof transformers.pipeline, "function");
  });

  it("imports of sharp from @huggingface/transformers receive the placeholder", async () => {
    installSharpUnavailableStub();
    const keysBefore = sharpCacheKeys();

    assert.equal(isTransformersSharpCaller("/app/node_modules/@huggingface/transformers/src/utils/image.js"), true);
    assert.equal(isTransformersSharpCaller("C:\\app\\node_modules\\@huggingface\\transformers\\src\\utils\\image.js"), true);
    assert.equal(isTransformersSharpCaller("file:///app/node_modules/@huggingface/transformers/dist/transformers.node.mjs"), true);
    assert.equal(isTransformersSharpCaller({ filename: "/app/tests/selftest-sharp-degrade.test.js" }), false);
    assert.equal(isTransformersSharpCaller({ parentURL: "file:///app/lib/native/sharp-unavailable.js" }), false);
    assert.equal(isTransformersSharpCaller(null), false);

    const req = createRequire(import.meta.url);
    const transformersEntry = req.resolve("@huggingface/transformers");
    assert.equal(isTransformersSharpCaller(transformersEntry), true);
    const fromTransformers = createRequire(transformersEntry)("sharp");
    assert.equal(sharpVersion(fromTransformers), "unavailable");
    assert.throws(() => fromTransformers(), (error) => error.reason === SHARP_UNAVAILABLE_REASON);
    assert.deepEqual(sharpCacheKeys(), keysBefore);

    const fakeDir = join(makeTempDir("st-tf-sharp-"), "node_modules", "@huggingface", "transformers");
    mkdirSync(fakeDir, { recursive: true });
    const fakeFile = join(fakeDir, "load-sharp.mjs");
    writeFileSync(fakeFile, 'import sharp from "sharp";\nexport default sharp;\n');
    const esm = await import(pathToFileURL(fakeFile).href);
    assert.equal(sharpVersion(esm), "unavailable");
    assert.throws(() => (esm.default ?? esm)(), (error) => error.reason === SHARP_UNAVAILABLE_REASON);
  });
});
