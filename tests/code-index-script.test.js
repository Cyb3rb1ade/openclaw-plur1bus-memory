import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function tempWorkspace() {
  return mkdtempSync(join(tmpdir(), "plur1bus-code-index-cli-"));
}

describe("build-code-index script", () => {
  it("writes .plur1bus/code-index.json for a workspace", () => {
    const rootDir = tempWorkspace();
    mkdirSync(join(rootDir, "lib"), { recursive: true });
    writeFileSync(join(rootDir, "index.js"), "export function activate() { return 1; }\n", "utf8");
    writeFileSync(join(rootDir, "lib", "helper.js"), "export const helper = () => 2;\n", "utf8");

    const result = spawnSync(process.execPath, ["scripts/build-code-index.mjs", rootDir], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /code-index files=2 symbols=2/);
    const indexPath = join(rootDir, ".plur1bus", "code-index.json");
    assert.equal(existsSync(indexPath), true);
    const index = JSON.parse(readFileSync(indexPath, "utf8"));
    assert.equal(index.kind, "plur1bus-code-index");
    assert.equal(index.files.length, 2);
  });
});
