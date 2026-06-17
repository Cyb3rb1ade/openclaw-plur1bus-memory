import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(__dirname, "..", "scripts", "protect-plur1bus-deploy.sh");

describe("protect-plur1bus-deploy.sh", () => {
  it("does not reference a missing cleanup-stores.mjs in the FILES array", () => {
    const script = readFileSync(scriptPath, "utf8");
    // Extract the FILES array contents.
    const match = script.match(/FILES=\(\s*([\s\S]*?)\s*\)/);
    assert.ok(match, "FILES array not found in script");
    const files = match[1]
      .split("\n")
      .map((line) => line.trim().replace(/^[#].*$/, "")) // drop comment-only lines
      .filter((line) => line.length > 0)
      .map((line) => line.replace(/^["']|["']$/g, ""));

    assert.ok(files.length > 0, "FILES array appears empty");
    assert.ok(
      !files.includes("scripts/cleanup-stores.mjs"),
      "scripts/cleanup-stores.mjs must not be in FILES; the file does not exist and would look like drift",
    );
  });

  it("includes a comment explaining why cleanup-stores.mjs was removed", () => {
    const script = readFileSync(scriptPath, "utf8");
    assert.ok(
      /cleanup-stores\.mjs/.test(script) &&
        /does not exist|missing|destructive cleanup|do not ship|drift/.test(script),
      "expected a comment explaining the cleanup-stores.mjs removal/guard",
    );
  });
});
