import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as ts from "typescript";

import { indexSourceFileWithTypescript } from "../lib/code-index/ts-source-indexer.js";

describe("code index TypeScript source indexer", () => {
  it("indexes imports, exported symbols, calls, and command registrations from JavaScript", () => {
    const sourceText = [
      "import defaultThing, { helper as runHelper } from './helper.js';",
      "export async function registerPlugin(api) {",
      "  api.commands.register('/plur1bus ast', runAst);",
      "  return runHelper(defaultThing);",
      "}",
      "class LocalWorker {",
      "  run() { return runAst(); }",
      "}",
      "function runAst() {",
      "  return new LocalWorker();",
      "}",
      "",
    ].join("\n");

    const fragment = indexSourceFileWithTypescript({
      filePath: "/repo/index.js",
      rootDir: "/repo",
      sourceText,
      ts,
    });

    assert.equal(fragment.file.path, "index.js");
    assert.equal(fragment.file.language, "javascript");
    assert.equal(fragment.file.hash.startsWith("sha256:"), true);
    assert.deepStrictEqual(fragment.file.imports, [
      { source: "./helper.js", specifiers: ["defaultThing", "runHelper"], kind: "esm" },
    ]);
    assert.deepStrictEqual(fragment.file.exports, ["registerPlugin"]);

    const symbols = Object.fromEntries(fragment.symbols.map((symbol) => [symbol.name, symbol]));
    assert.equal(symbols.registerPlugin.kind, "function");
    assert.equal(symbols.registerPlugin.exported, true);
    assert.equal(symbols.registerPlugin.async, true);
    assert.equal(symbols.registerPlugin.range.startLine, 2);
    assert.equal(symbols.LocalWorker.kind, "class");
    assert.equal(symbols.LocalWorker.exported, false);
    assert.match(symbols.registerPlugin.signature, /^export async function registerPlugin\(api\)/);

    assert.ok(fragment.chunks.some((chunk) => chunk.symbolId === symbols.registerPlugin.id && chunk.text.includes("api.commands.register")));
    assert.ok(fragment.edges.some((edge) => edge.type === "imports" && edge.to === "module:./helper.js"));
    assert.ok(fragment.edges.some((edge) => edge.type === "calls" && edge.from === symbols.registerPlugin.id && edge.to === "symbol-ref:runHelper"));
    assert.ok(fragment.edges.some((edge) => edge.type === "registers" && edge.command === "/plur1bus ast" && edge.handler === "runAst"));
  });
});
