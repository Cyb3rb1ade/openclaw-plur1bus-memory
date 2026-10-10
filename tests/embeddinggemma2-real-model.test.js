// Opt-in integration test with the REAL model: it downloads the pinned q8 export (about 346 MB, verified against the pinned
// SHA-256 values) and runs it through onnxruntime. Off by default so the suite never touches the network:
//
//   PLUR1BUS_REAL_EGEMMA2=1 [PLUR1BUS_REAL_MODEL_CACHE=<dir>] node --test tests/embeddinggemma2-real-model.test.js
//
// The cache directory is reused between runs; artifacts that already verify are not downloaded again.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";
import { EMBEDDINGGEMMA2_EMBEDDING_PROFILE, validatePinnedModelArtifacts } from "../lib/providers/local-model-artifacts.js";

const enabled = process.env.PLUR1BUS_REAL_EGEMMA2 === "1";
const cacheDir = process.env.PLUR1BUS_REAL_MODEL_CACHE || join(homedir(), ".cache", "plur1bus-real-model-tests");

const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
const norm = (a) => Math.hypot(...a);

describe("EmbeddingGemma 2, real model (opt-in: PLUR1BUS_REAL_EGEMMA2=1)", { skip: !enabled && "set PLUR1BUS_REAL_EGEMMA2=1 to download and run the real model" }, () => {
  it("downloads the pinned artifacts, embeds with the published prompts and ranks the Red Planet question correctly", { timeout: 20 * 60_000 }, async () => {
    mkdirSync(cacheDir, { recursive: true });
    const provider = new LocalTransformersEmbeddingProvider({ model: "google/embeddinggemma-2", dimensions: 768, cacheDir, embeddingCacheEnabled: false });
    try {
      const query = await provider.embedQuery("Which planet is known as the Red Planet?");
      const documents = await provider.embedBatch([
        "Venus is often called Earth's twin because of its similar size and proximity.",
        "Mars, known for its reddish appearance, is often referred to as the Red Planet.",
        "Jupiter, the largest planet in our solar system, has a prominent red spot.",
        "Saturn, famous for its rings, is sometimes mistaken for the Red Planet.",
      ]);
      assert.equal(query.length, 768);
      assert.ok(Math.abs(norm(query) - 1) < 1e-3, "768d vector is a unit vector");
      const scores = documents.map((vector) => dot(query, vector));
      const best = scores.indexOf(Math.max(...scores));
      assert.equal(best, 1, `Mars ranks first, got scores ${scores.map((x) => x.toFixed(3)).join(", ")}`);
      assert.ok(scores[1] > 0.7, `the published example scores 0.854, got ${scores[1].toFixed(3)}`);

      const report = await validatePinnedModelArtifacts(EMBEDDINGGEMMA2_EMBEDDING_PROFILE, cacheDir);
      assert.equal(report.ok, true, "every cached artifact still matches its pin");
    } finally {
      await provider.shutdown();
    }
  });

  it("truncates to the Matryoshka widths and keeps the direction of the full vector", { timeout: 20 * 60_000 }, async () => {
    const full = new LocalTransformersEmbeddingProvider({ model: "google/embeddinggemma-2", dimensions: 768, cacheDir, embeddingCacheEnabled: false });
    const small = new LocalTransformersEmbeddingProvider({ model: "google/embeddinggemma-2", dimensions: 256, cacheDir, embeddingCacheEnabled: false });
    try {
      const text = "Das Gedächtnis eines Agenten soll lokal und privat bleiben.";
      const wide = await full.embedPassage(text);
      const narrow = await small.embedPassage(text);
      assert.equal(narrow.length, 256);
      assert.ok(Math.abs(norm(narrow) - 1) < 1e-3);
      const prefix = wide.slice(0, 256);
      const cosine = dot(narrow, prefix) / (norm(narrow) * norm(prefix));
      assert.ok(cosine > 0.999, `the 256d vector is the re-normalized prefix of the 768d vector, cosine ${cosine}`);
    } finally {
      await full.shutdown();
      await small.shutdown();
    }
  });
});
