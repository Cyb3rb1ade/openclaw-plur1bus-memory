import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { resolveNamespaceLayout } from "../lib/namespace-config.js";
import { resolveEmbeddingGenerationLayout } from "../lib/reembedding/generation-layout.js";

const targetFingerprintId = `embedding:v1:sha256:${"a".repeat(64)}`;

describe("active embedding generation routing", () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "plur1bus-generation-layout-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("preserves the current named writer until a generation is selected", () => {
    const original = resolveNamespaceLayout(root, {
      activeWriteNamespace: "lab",
      activeRecallNamespaces: ["lab"],
    }, { explicit: true });
    const result = resolveEmbeddingGenerationLayout({ stateRoot: root, namespaceLayout: original });
    assert.equal(result.selection.mode, "legacy");
    assert.equal(result.activeRoot, join(root, "lab"));
    assert.equal(result.dataLayout, original);
    assert.equal(result.sharedBaseDir, root);
  });

  it("routes private and shared data into a verified named generation", () => {
    const generationRoot = join(root, "generations", "generation-a");
    mkdirSync(generationRoot, { recursive: true });
    writeFileSync(join(generationRoot, "generation.json"), JSON.stringify({
      schemaVersion: 1,
      generation: "generation-a",
      fingerprintId: targetFingerprintId,
      dimensions: 768,
      tables: {},
    }));
    const original = resolveNamespaceLayout(root, {
      activeWriteNamespace: "lab",
      activeRecallNamespaces: ["lab"],
    }, { explicit: true });
    const result = resolveEmbeddingGenerationLayout({
      stateRoot: root,
      namespaceLayout: original,
      selection: {
        activeGeneration: "generation-a",
        fingerprintId: targetFingerprintId,
        dimensions: 768,
      },
    });
    assert.deepStrictEqual(result.selection, { mode: "generation", generation: "generation-a" });
    assert.equal(result.dataLayout.baseDir, generationRoot);
    assert.equal(result.activeRoot, join(generationRoot, "lab"));
    assert.equal(result.sharedBaseDir, generationRoot);
  });

  it("fails closed on absent, malformed, or mismatched generation manifests", () => {
    const original = resolveNamespaceLayout(root);
    const selection = {
      activeGeneration: "generation-a",
      fingerprintId: targetFingerprintId,
      dimensions: 4,
    };
    assert.throws(
      () => resolveEmbeddingGenerationLayout({ stateRoot: root, namespaceLayout: original, selection }),
      /manifest/i,
    );
    const generationRoot = join(root, "generations", "generation-a");
    mkdirSync(generationRoot, { recursive: true });
    writeFileSync(join(generationRoot, "generation.json"), JSON.stringify({
      schemaVersion: 1,
      generation: "generation-a",
      fingerprintId: `embedding:v1:sha256:${"b".repeat(64)}`,
      dimensions: 4,
      tables: {},
    }));
    assert.throws(
      () => resolveEmbeddingGenerationLayout({ stateRoot: root, namespaceLayout: original, selection }),
      /fingerprint mismatch/i,
    );
  });
});
