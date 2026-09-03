import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveNamespaceLayout } from "../namespace-config.js";
import { resolveInside } from "../sql-safety.js";

const GENERATION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FINGERPRINT_ID_RE = /^embedding:v1:sha256:[a-f0-9]{64}$/;

function generationId(value) {
  if (typeof value !== "string" || !GENERATION_RE.test(value)) throw new Error("invalid active embedding generation");
  return value;
}

function readGenerationManifest(stateRoot, generation) {
  try {
    const generationRoot = resolveInside(stateRoot, "generations", generation);
    const manifestPath = resolveInside(generationRoot, "generation.json");
    const rootStat = lstatSync(generationRoot);
    const manifestStat = lstatSync(manifestPath);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !manifestStat.isFile() || manifestStat.isSymbolicLink()) {
      throw new Error("generation manifest path is not an ordinary in-root file");
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (
      manifest?.schemaVersion !== 1
      || manifest.generation !== generation
      || !FINGERPRINT_ID_RE.test(manifest.fingerprintId)
      || !Number.isSafeInteger(manifest.dimensions)
      || manifest.dimensions <= 0
      || !manifest.tables
      || typeof manifest.tables !== "object"
      || Array.isArray(manifest.tables)
    ) throw new Error("invalid generation manifest fields");
    return { generationRoot, manifest };
  } catch (cause) {
    const error = new Error(`active embedding generation manifest is invalid: ${generation}`);
    error.cause = cause;
    throw error;
  }
}

/** Resolve immutable private/shared Lance routing for the configured active generation. */
export function resolveEmbeddingGenerationLayout({ stateRoot, namespaceLayout, selection = {} } = {}) {
  if (typeof stateRoot !== "string" || !stateRoot) throw new Error("embedding generation state root is required");
  if (!namespaceLayout || typeof namespaceLayout !== "object" || !Object.isFrozen(namespaceLayout)) {
    throw new Error("normalized namespace layout is required");
  }
  if (!selection?.activeGeneration) {
    return Object.freeze({
      selection: Object.freeze({ mode: "legacy" }),
      dataLayout: namespaceLayout,
      activeRoot: namespaceLayout.mode === "named"
        ? join(namespaceLayout.baseDir, namespaceLayout.activeWriteNamespace)
        : namespaceLayout.baseDbPath,
      sharedBaseDir: namespaceLayout.baseDir,
      manifest: null,
    });
  }
  const generation = generationId(selection.activeGeneration);
  if (!FINGERPRINT_ID_RE.test(selection.fingerprintId)) throw new Error("invalid active embedding fingerprint id");
  if (!Number.isSafeInteger(selection.dimensions) || selection.dimensions <= 0) {
    throw new Error("invalid active embedding dimensions");
  }
  const { generationRoot, manifest } = readGenerationManifest(stateRoot, generation);
  if (manifest.fingerprintId !== selection.fingerprintId) throw new Error("active embedding generation fingerprint mismatch");
  if (manifest.dimensions !== selection.dimensions) throw new Error("active embedding generation dimension mismatch");
  const dataLayout = namespaceLayout.mode === "named"
    ? resolveNamespaceLayout(generationRoot, {
        activeWriteNamespace: namespaceLayout.activeWriteNamespace,
        activeRecallNamespaces: namespaceLayout.activeRecallNamespaces,
        legacyReadOnlyNamespaces: namespaceLayout.legacyReadOnlyNamespaces,
        crossNamespaceRecall: namespaceLayout.crossNamespaceRecall,
      }, { explicit: true })
    : resolveNamespaceLayout(generationRoot);
  return Object.freeze({
    selection: Object.freeze({ mode: "generation", generation }),
    dataLayout,
    activeRoot: dataLayout.mode === "named"
      ? resolveInside(dataLayout.baseDir, dataLayout.activeWriteNamespace)
      : dataLayout.baseDbPath,
    sharedBaseDir: dataLayout.baseDir,
    manifest: Object.freeze(structuredClone(manifest)),
  });
}
