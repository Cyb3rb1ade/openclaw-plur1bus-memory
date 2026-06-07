/**
 * tests/i18n-coverage.test.js — Missing-key / coverage guard.
 *
 * Fails if any t() call in the source references a key not present
 * in dictionary.en.default.
 *
 * In production: missing key logs warning and returns key string.
 * In tests: missing key fails the test.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { dictionary } from "../lib/i18n-dictionary.js";

const SRC_DIRS = ["lib", "."];
const SRC_EXTS = new Set([".js"]);
const EXCLUDE_FILES = new Set(["i18n-dictionary.js"]);
// Test files may intentionally reference non-existent keys (fallback tests).
const EXCLUDE_DIRS = new Set(["tests"]);
// Deliberately missing keys used in fallback-behaviour tests.
const ALLOWED_MISSING_KEYS = new Set(["nonexistent.key.12345"]);

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith("node_modules")) continue;
    if (entry.startsWith(".")) continue;
    if (EXCLUDE_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    const st = statSync(path);
    if (st.isDirectory()) {
      walk(path, files);
    } else if (st.isFile() && SRC_EXTS.has(entry.slice(entry.lastIndexOf(".")))) {
      if (!EXCLUDE_FILES.has(entry)) files.push(path);
    }
  }
  return files;
}

function extractTKeys(source) {
  const keys = new Set();
  // Match t("key"... or t('key'... — first argument must be a string literal.
  // \b ensures 't' is a standalone identifier (not part of limit/format/target/test/etc).
  const re = /\bt\(\s*(["'])(.+?)\1/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    keys.add(m[2]);
  }
  return [...keys];
}

describe("i18n coverage guard", () => {
  it("every t() key exists in dictionary.en.default", () => {
    const files = SRC_DIRS.flatMap((d) => {
      try {
        return walk(d);
      } catch (_) {
        return [];
      }
    });

    const allKeys = new Set();
    const missing = [];
    const fileMap = new Map(); // key → [files]

    for (const path of files) {
      let source;
      try {
        source = readFileSync(path, "utf8");
      } catch (_) {
        continue;
      }
      const keys = extractTKeys(source);
      for (const key of keys) {
        allKeys.add(key);
        if (!fileMap.has(key)) fileMap.set(key, []);
        fileMap.get(key).push(path);
      }
    }

    for (const key of allKeys) {
      if (ALLOWED_MISSING_KEYS.has(key)) continue;
      if (!dictionary[key]?.en?.default) {
        missing.push({ key, files: fileMap.get(key) });
      }
    }

    if (missing.length > 0) {
      const report = missing
        .map((m) => `  - "${m.key}" used in: ${m.files.join(", ")}`)
        .join("\n");
      assert.fail(`Missing dictionary keys (no en.default):\n${report}`);
    }
  });
});
