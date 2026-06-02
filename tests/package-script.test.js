import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

describe("package scripts", () => {
  it("npm test targets the real tests directory", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.strictEqual(pkg.scripts.test, "node --test tests/*.test.js");
  });
});
