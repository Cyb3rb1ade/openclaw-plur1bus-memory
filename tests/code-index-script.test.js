import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main as runCodeIndex } from "../scripts/build-code-index.mjs";

function tempWorkspace() {
  return mkdtempSync(join(tmpdir(), "plur1bus-code-index-cli-"));
}

async function captureConsoleLog(fn) {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => { lines.push(args.join(" ")); };
  try {
    const status = await fn();
    return { status, stdout: lines.join("\n") };
  } finally {
    console.log = originalLog;
  }
}

describe("build-code-index script", () => {
  it("writes .plur1bus/code-index.json for a workspace", async () => {
    const rootDir = tempWorkspace();
    mkdirSync(join(rootDir, "lib"), { recursive: true });
    writeFileSync(join(rootDir, "index.js"), "export function activate() { return 1; }\n", "utf8");
    writeFileSync(join(rootDir, "lib", "helper.js"), "export const helper = () => 2;\n", "utf8");

    const result = await captureConsoleLog(() => runCodeIndex([rootDir]));

    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /code-index files=2 symbols=2/);
    const indexPath = join(rootDir, ".plur1bus", "code-index.json");
    assert.equal(existsSync(indexPath), true);
    const index = JSON.parse(readFileSync(indexPath, "utf8"));
    assert.equal(index.kind, "plur1bus-code-index");
    assert.equal(index.files.length, 2);
  });

  it("prints a bounded code-context block when --query is provided", async () => {
    const rootDir = tempWorkspace();
    writeFileSync(join(rootDir, "index.js"), [
      "export function activate(api) {",
      "  api.commands.register('/plur1bus code-index', runCodeIndex);",
      "}",
      "function runCodeIndex() { return 'ok'; }",
      "",
    ].join("\n"), "utf8");

    const result = await captureConsoleLog(() => runCodeIndex([
      rootDir,
      "--query",
      "/plur1bus code-index",
    ]));

    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /code-index query="\/plur1bus code-index" results=1/);
    assert.match(result.stdout, /<code-context source="plur1bus-code-index" query="\/plur1bus code-index">/);
    assert.match(result.stdout, /<command>\/plur1bus code-index<\/command>/);
  });
});
