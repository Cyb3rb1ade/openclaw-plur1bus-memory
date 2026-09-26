/**
 * engine/store/lancedb-loader.js — lazy loaders for the LanceDB and OpenAI packages (direct import, plugin node_modules, legacy stock path).
 *
 * Moved verbatim from index.js (engine extraction, step 9 part 1); index.js
 * imports what the host registration still uses and re-exports the public names.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { PLUGIN_ROOT } from "../../lib/plugin-meta.js";

const LANCEDB_LEGACY_PATH = join(PLUGIN_ROOT, "../memory-lancedb-stock/node_modules/@lancedb/lancedb/dist/index.js");
const OPENAI_LEGACY_PATH  = join(PLUGIN_ROOT, "../memory-lancedb-stock/node_modules/openai/index.js");
// v6.2.1 — Zusätzliche Fallback-Pfade für npm-Installationen (P0-Fix)
const LANCEDB_PLUGIN_PATH = join(PLUGIN_ROOT, "node_modules/@lancedb/lancedb/dist/index.js");
const OPENAI_PLUGIN_PATH  = join(PLUGIN_ROOT, "node_modules/openai/index.js");

// Lazy-loaded modules
let _lancedb = null;
let _OpenAI = null;

async function getLanceDB() {
  if (!_lancedb) {
    try {
      _lancedb = await import("@lancedb/lancedb");
      return _lancedb;
    } catch (directErr) {
      // v6.2.1 — Versuche Plugin-eigenes node_modules (P0-Fix)
      if (existsSync(LANCEDB_PLUGIN_PATH)) {
        _lancedb = await import(LANCEDB_PLUGIN_PATH);
        return _lancedb;
      }
      // v6.2.1 — Versuche Legacy-Pfad (P0-Fix)
      if (existsSync(LANCEDB_LEGACY_PATH)) {
        _lancedb = await import(LANCEDB_LEGACY_PATH);
        return _lancedb;
      }
      throw new Error(
        `memory-lancedb-namespaced: LanceDB dependency not found. ` +
        `Install the plugin package dependencies: npm install @lancedb/lancedb. ` +
        `Direct import failed: ${directErr?.message || String(directErr)}`
      );
    }
  }
  return _lancedb;
}

async function getOpenAI() {
  if (!_OpenAI) {
    try {
      const m = await import("openai");
      _OpenAI = m.default;
      return _OpenAI;
    } catch (directErr) {
      // v6.2.1 — Versuche Plugin-eigenes node_modules (P0-Fix)
      if (existsSync(OPENAI_PLUGIN_PATH)) {
        const m = await import(OPENAI_PLUGIN_PATH);
        _OpenAI = m.default;
        return _OpenAI;
      }
      // v6.2.1 — Versuche Legacy-Pfad (P0-Fix)
      if (existsSync(OPENAI_LEGACY_PATH)) {
        const m = await import(OPENAI_LEGACY_PATH);
        _OpenAI = m.default;
        return _OpenAI;
      }
      throw new Error(
        `memory-lancedb-namespaced: openai dependency not found. ` +
        `Install the plugin package dependencies: npm install openai. ` +
        `Direct import failed: ${directErr?.message || String(directErr)}`
      );
    }
  }
  return _OpenAI;
}

export { getLanceDB, getOpenAI };
