import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import * as ts from "typescript";

import {
  CODE_INDEX_PATH_REL,
  buildCodeIndexForFiles,
  discoverCodeFiles,
  loadCodeIndex,
  saveCodeIndex,
} from "../lib/code-index/workspace-indexer.js";

function tempWorkspace() {
  return mkdtempSync(join(tmpdir(), "plur1bus-code-index-"));
}

describe("code index workspace indexer", () => {
  it("discovers source files while ignoring generated and dependency folders", async () => {
    const rootDir = tempWorkspace();
    mkdirSync(join(rootDir, "lib"), { recursive: true });
    mkdirSync(join(rootDir, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(rootDir, ".plur1bus"), { recursive: true });
    writeFileSync(join(rootDir, "index.js"), "export function main() {}\n", "utf8");
    writeFileSync(join(rootDir, "lib", "worker.mjs"), "export class Worker {}\n", "utf8");
    writeFileSync(join(rootDir, "node_modules", "pkg", "ignored.js"), "export const ignored = true;\n", "utf8");
    writeFileSync(join(rootDir, ".plur1bus", "ignored.js"), "export const ignored = true;\n", "utf8");

    const files = await discoverCodeFiles(rootDir);

    const realRoot = realpathSync(rootDir);
    assert.deepStrictEqual(files.map((file) => relative(realRoot, file)).sort(), [
      "index.js",
      join("lib", "worker.mjs"),
    ].sort());
  });

  it("builds and persists a normalized workspace code index", async () => {
    const rootDir = tempWorkspace();
    mkdirSync(join(rootDir, "lib"), { recursive: true });
    writeFileSync(join(rootDir, "index.js"), [
      "import { run } from './lib/run.js';",
      "export function activate(api) {",
      "  api.commands.register('/plur1bus code-index', run);",
      "}",
      "",
    ].join("\n"), "utf8");
    writeFileSync(join(rootDir, "lib", "run.js"), "export function run() { return 'ok'; }\n", "utf8");

    const index = await buildCodeIndexForFiles({
      rootDir,
      filePaths: [join(rootDir, "index.js"), join(rootDir, "lib", "run.js")],
      ts,
    });

    assert.equal(index.version, 1);
    assert.equal(index.kind, "plur1bus-code-index");
    assert.equal(index.files.length, 2);
    assert.ok(index.symbols.some((symbol) => symbol.name === "activate" && symbol.filePath === "index.js"));
    assert.ok(index.symbols.some((symbol) => symbol.name === "run" && symbol.filePath === "lib/run.js"));
    assert.ok(index.edges.some((edge) => edge.type === "registers" && edge.command === "/plur1bus code-index"));
    assert.ok(index.chunks.every((chunk) => chunk.hash.startsWith("sha256:")));

    saveCodeIndex(rootDir, index);
    const savedText = readFileSync(join(rootDir, CODE_INDEX_PATH_REL), "utf8");
    assert.match(savedText, /"plur1bus-code-index"/);
    assert.equal(loadCodeIndex(rootDir).files.length, 2);
  });
});
