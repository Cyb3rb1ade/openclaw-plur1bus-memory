import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  formatCodeContextBlock,
  searchCodeIndex,
} from "../lib/code-index/query.js";

function sampleIndex() {
  return {
    kind: "plur1bus-code-index",
    files: [
      { id: "file:index.js", path: "index.js", language: "javascript" },
      { id: "file:lib/run.js", path: "lib/run.js", language: "javascript" },
    ],
    symbols: [
      {
        id: "sym:activate",
        kind: "function",
        name: "activate",
        filePath: "index.js",
        signature: "export function activate(api)",
        range: { startLine: 1, endLine: 4 },
      },
      {
        id: "sym:run",
        kind: "function",
        name: "run",
        filePath: "lib/run.js",
        signature: "export function run()",
        range: { startLine: 1, endLine: 1 },
      },
    ],
    edges: [
      {
        id: "edge:registers",
        type: "registers",
        from: "sym:activate",
        to: "command:/plur1bus code-index",
        command: "/plur1bus code-index",
        handler: "run",
      },
      { id: "edge:calls", type: "calls", from: "sym:activate", to: "symbol-ref:run", name: "run" },
    ],
    chunks: [
      {
        id: "chunk:activate",
        kind: "symbol",
        filePath: "index.js",
        symbolId: "sym:activate",
        text: "export function activate(api) { api.commands.register('/plur1bus code-index', run); }",
      },
      {
        id: "chunk:run",
        kind: "symbol",
        filePath: "lib/run.js",
        symbolId: "sym:run",
        text: "export function run() { return 'ok'; }",
      },
    ],
  };
}

describe("code index query", () => {
  it("ranks command registration matches ahead of incidental text matches", () => {
    const results = searchCodeIndex(sampleIndex(), "/plur1bus code-index", { limit: 2 });

    assert.equal(results[0].symbol.name, "activate");
    assert.equal(results[0].file.path, "index.js");
    assert.ok(results[0].score > (results[1]?.score || 0));
    assert.ok(results[0].matchTypes.includes("command"));
    assert.deepStrictEqual(results[0].commands, ["/plur1bus code-index"]);
  });

  it("formats bounded code context without dumping full source files", () => {
    const results = searchCodeIndex(sampleIndex(), "activate code-index", { limit: 1 });
    const block = formatCodeContextBlock(results, { query: "activate code-index", maxChars: 600 });

    assert.match(block, /^<code-context source="plur1bus-code-index" query="activate code-index">/);
    assert.match(block, /<symbol name="activate" kind="function" file="index\.js" lines="1-4">/);
    assert.match(block, /<command>\/plur1bus code-index<\/command>/);
    assert.match(block, /export function activate\(api\)/);
    assert.match(block, /<\/code-context>$/);
    assert.ok(block.length <= 600);
  });
});
