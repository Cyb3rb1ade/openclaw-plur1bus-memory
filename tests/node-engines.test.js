/**
 * tests/node-engines.test.js
 *
 * PLUR1BUS laeuft im Prozess des OpenClaw-Gateways. Was der Host an Node
 * verlangt, gilt damit auch fuer das Plugin — eine eigene, aeltere Untergrenze
 * ist keine zusaetzliche Vertraeglichkeit, sondern eine Falschaussage.
 *
 * OpenClaw 2026.9.5 verlangt ">=24.16.0 <25 || >=26.1.0". Bis 7.12.70 stand im
 * Paket ">=22.22.3" und die CI pruefte auf Node 22 — eine Kombination, in der
 * der Host gar nicht startet. Diese Tests halten beides zusammen.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const workflowDir = fileURLToPath(new URL("../.github/workflows", import.meta.url));

describe("Node-Untergrenze", () => {
  it("beginnt bei 24, nicht darunter", () => {
    assert.match(pkg.engines.node, /^>=24\./, `engines.node ist "${pkg.engines.node}"`);
  });

  it("laesst keine Node-22- oder -23-Zeile zu", () => {
    assert.doesNotMatch(pkg.engines.node, /(^|[^.\d])2[23]\./);
  });

  it("steht im Lockfile genauso", () => {
    assert.equal(lock.packages[""].engines.node, pkg.engines.node);
  });
});

describe("CI prueft, was auch laeuft", () => {
  const workflows = readdirSync(workflowDir).filter((n) => n.endsWith(".yml"));

  it("findet ueberhaupt Workflows", () => {
    assert.ok(workflows.length > 0);
  });

  for (const name of workflows) {
    it(`${name} pinnt keine Node-Version unter 24`, () => {
      const text = readFileSync(join(workflowDir, name), "utf8");
      for (const line of text.split("\n")) {
        if (!line.includes("node-version:")) continue;
        if (line.includes("matrix.node-version")) continue;
        const versions = line.match(/\d+(?:\.\d+)*/g) || [];
        for (const v of versions) {
          assert.ok(Number(v.split(".")[0]) >= 24, `${name}: "${line.trim()}" pinnt Node ${v}`);
        }
      }
    });
  }
});
