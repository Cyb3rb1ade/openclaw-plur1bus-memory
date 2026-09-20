import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const readRepoFile = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// Massgeblich ist der Host: dieses Plugin laeuft ausschliesslich im Prozess des
// OpenClaw-Gateways, also gilt dessen Node-Anforderung auch hier. Eine eigene,
// aeltere Untergrenze ist keine zusaetzliche Vertraeglichkeit, sondern eine
// Falschaussage gegenueber jedem, der sie liest.
//
// Historie: Bis 7.5.0 lag der Boden auf 22.5.0 und hielt nicht — `node:sqlite`
// lief dort nur mit --experimental-sqlite, und die Auto-Capture-Tests
// scheiterten auf 22.5 bis 22.11 an der Semantik des damaligen Testlaeufers
// (gemessen 03.09.26: 22.5.0, 22.6 und 22.9 rot, ab 22.12 gruen). Danach
// 22.22.3, abgeleitet aus OpenClaw 2026.8.2.
//
// 20.09.26: OpenClaw 2026.9.5 verlangt ">=24.16.0 <25 || >=26.1.0" und startet
// unter Node 22 gar nicht — die CI prueft bis hierhin also eine Konstellation,
// die es nicht geben kann, waehrend die tatsaechlich benutzte (Node 24) in
// keinem Lauf vorkam. Aeltere Gateways bleiben nutzbar: 2026.8.2 erlaubt
// ">=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0", also ebenfalls Node 24.
// Ausgeschlossen ist damit nur, einen solchen Host auf Node 22 zu fahren.
const FLOOR = ">=24.16.0 <25 || >=26.1.0";

test("Node.js 24.16.0 is the package, CI, and installation runtime floor", () => {
  const packageJson = JSON.parse(readRepoFile("package.json"));
  const packageLock = JSON.parse(readRepoFile("package-lock.json"));
  const workflow = readRepoFile(".github/workflows/ci.yml");
  const readme = readRepoFile("README.md");

  assert.equal(packageJson.engines.node, FLOOR);
  assert.equal(packageLock.packages[""].engines.node, FLOOR);
  assert.match(workflow, /node-version:\s*\['24\.16\.0', 24\]/);
  assert.doesNotMatch(workflow, /20\.9\.0/);
  assert.doesNotMatch(workflow, /22\.5\.0/);
  // Die aktuelle Aussage steht im Kopf der README; die "New in v7.x"-Abschnitte
  // nennen weiterhin 22.22 und sollen das auch, sie beschreiben ihren Stand.
  assert.match(readme, /requires the same Node as its host/);
  assert.match(readme, /24\.16\.0 <25 \|\| >=26\.1\.0/);
  assert.match(
    readme,
    /node:sqlite.*available throughout the supported Node\.js runtime range/,
  );
});

// Die Matrix in ci.yml war nicht die einzige Stelle: zwei macOS-Workflows
// pinnten ihre Node-Version separat und wurden beim letzten Anheben vergessen.
test("no workflow pins a Node version below the floor", () => {
  const dir = fileURLToPath(new URL("../.github/workflows", import.meta.url));
  const workflows = readdirSync(dir).filter((name) => name.endsWith(".yml"));
  assert.ok(workflows.length > 0, "keine Workflows gefunden");

  for (const name of workflows) {
    for (const line of readRepoFile(`.github/workflows/${name}`).split("\n")) {
      if (!line.includes("node-version:")) continue;
      if (line.includes("matrix.node-version")) continue;
      for (const version of line.match(/\d+(?:\.\d+)*/g) || []) {
        assert.ok(
          Number(version.split(".")[0]) >= 24,
          `${name}: "${line.trim()}" pinnt Node ${version}`,
        );
      }
    }
  }
});
