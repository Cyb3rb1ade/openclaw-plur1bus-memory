/**
 * Tests für scripts/migrate-neo-workspace-generations.mjs.
 *
 * Die Migration führt historische Workspace-Generationen zusammen. Sie
 * arbeitet auf unwiederbringlichen Produktionsdaten — deshalb liegt der
 * Schwerpunkt auf: nichts ohne --apply, keine Duplikate bei Wiederholung,
 * und nichts raten, was sich nicht zuordnen lässt.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { planMigration, migrateWorkspace } from "../scripts/migrate-neo-workspace-generations.mjs";

const CANONICAL = "workspace-bernhardine--7722278e420517df6437";
const KEY = "workspace-bernhardine";

function writeJsonl(dir, file, records) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

function episode(id, agentId = "bernhardine", startTime = "2026-07-01T10:00:00.000Z") {
  return { id, agentId, title: `Episode ${id}`, startTime };
}

/** Baut die drei Generationen in einem temporären _neo-Verzeichnis auf. */
function fixture({ gen1 = [], gen2 = [], gen3 = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "neo-migrate-"));
  const workspaces = join(root, "workspaces");
  if (gen3.length) writeJsonl(join(workspaces, CANONICAL), "episodes.jsonl", gen3);
  else mkdirSync(join(workspaces, CANONICAL), { recursive: true });
  if (gen2.length) writeJsonl(join(workspaces, KEY), "episodes.jsonl", gen2);
  if (gen1.length) writeJsonl(join(workspaces, "bernhardine"), "episodes.jsonl", gen1);
  return { root, workspaces };
}

function readEpisodeIds(workspaces) {
  const path = join(workspaces, CANONICAL, "episodes.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).id);
}

describe("planMigration", () => {
  it("ordnet Gen1 und Gen2 dem kanonischen Verzeichnis zu", () => {
    const { root, workspaces } = fixture({ gen1: [episode("a")], gen2: [episode("b")], gen3: [episode("c")] });
    try {
      const { plans } = planMigration(workspaces);
      assert.equal(plans.length, 1);
      assert.equal(plans[0].canonicalDir, CANONICAL);
      assert.equal(plans[0].workspaceKey, KEY);
      assert.deepEqual(plans[0].sources.sort(), ["bernhardine", KEY]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("überspringt ein Verzeichnis, dessen agentId nicht zum Workspace passt, statt zu raten", () => {
    const { root, workspaces } = fixture({ gen3: [episode("c")] });
    try {
      // Fremdes Verzeichnis mit abweichender agentId.
      writeJsonl(join(workspaces, "fremd"), "episodes.jsonl", [episode("x", "jemand-anders")]);
      const { plans, skipped } = planMigration(workspaces);
      const claimed = plans.flatMap((p) => p.sources);
      assert.equal(claimed.includes("fremd"), false, "darf nicht zugeordnet werden");
      assert.equal(skipped.some((s) => s.dir === "fremd"), true, "muss gemeldet werden");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("meldet leere Verzeichnisse, ohne sie zu löschen", () => {
    const { root, workspaces } = fixture({ gen3: [episode("c")] });
    try {
      mkdirSync(join(workspaces, "workspace-dir_v1_leer--abc"), { recursive: true });
      mkdirSync(join(workspaces, "leer-alt"), { recursive: true });
      const { empty } = planMigration(workspaces);
      assert.equal(empty.includes("leer-alt"), true);
      assert.equal(existsSync(join(workspaces, "leer-alt")), true, "darf nicht geloescht werden");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("migrateWorkspace", () => {
  it("dry-run schreibt nichts und meldet die korrekte Anzahl", () => {
    const { root, workspaces } = fixture({ gen1: [episode("a"), episode("b")], gen3: [episode("c")] });
    try {
      const [plan] = planMigration(workspaces).plans;
      const report = migrateWorkspace(workspaces, plan, { apply: false });
      assert.equal(report.episodes.existing, 1);
      assert.equal(report.episodes.wouldAdd, 2);
      assert.deepEqual(readEpisodeIds(workspaces), ["c"], "dry-run darf nichts schreiben");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("--apply führt alle Generationen zusammen", () => {
    const { root, workspaces } = fixture({ gen1: [episode("a")], gen2: [episode("b")], gen3: [episode("c")] });
    try {
      const [plan] = planMigration(workspaces).plans;
      migrateWorkspace(workspaces, plan, { apply: true, stamp: "test" });
      assert.deepEqual(readEpisodeIds(workspaces).sort(), ["a", "b", "c"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("dedupliziert über die id — kanonischer Record bleibt erhalten", () => {
    const { root, workspaces } = fixture({
      gen1: [episode("dup", "bernhardine", "2026-01-01T00:00:00.000Z")],
      gen3: [episode("dup")],
    });
    try {
      const [plan] = planMigration(workspaces).plans;
      migrateWorkspace(workspaces, plan, { apply: true, stamp: "test" });
      const ids = readEpisodeIds(workspaces);
      assert.deepEqual(ids, ["dup"], "id darf nur einmal vorkommen");
      const record = JSON.parse(readFileSync(join(workspaces, CANONICAL, "episodes.jsonl"), "utf8").split("\n")[0]);
      assert.equal(record.startTime, "2026-07-01T10:00:00.000Z", "kanonische Fassung gewinnt");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("ist idempotent — zweimal --apply erzeugt keine Duplikate", () => {
    const { root, workspaces } = fixture({ gen1: [episode("a")], gen2: [episode("b")], gen3: [episode("c")] });
    try {
      const [plan] = planMigration(workspaces).plans;
      migrateWorkspace(workspaces, plan, { apply: true, stamp: "t1" });
      migrateWorkspace(workspaces, plan, { apply: true, stamp: "t2" });
      assert.deepEqual(readEpisodeIds(workspaces).sort(), ["a", "b", "c"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("legt vor dem Schreiben ein Backup an", () => {
    const { root, workspaces } = fixture({ gen1: [episode("a")], gen3: [episode("c")] });
    try {
      const [plan] = planMigration(workspaces).plans;
      migrateWorkspace(workspaces, plan, { apply: true, stamp: "backup-test" });
      const backup = join(workspaces, CANONICAL, ".migration-backup-backup-test", "episodes.jsonl");
      assert.equal(existsSync(backup), true, "Backup muss existieren");
      assert.match(readFileSync(backup, "utf8"), /"c"/, "Backup haelt den Stand VOR der Migration");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("fasst reaction-ledger und behavior-cards NICHT an — der Append-Cap würde dort aktuelle Daten verdrängen", () => {
    // appendJsonl cappt grosse Dateien auf die LETZTEN NEO_MAX_RECORDS Zeilen.
    // Migrierte Records sind aelter, landen aber am Ende — ein Merge wuerde
    // also die alten behalten und die aktuellen wegwerfen.
    const root = mkdtempSync(join(tmpdir(), "neo-migrate-capped-"));
    const workspaces = join(root, "workspaces");
    try {
      writeJsonl(join(workspaces, CANONICAL), "episodes.jsonl", [episode("c")]);
      writeJsonl(join(workspaces, CANONICAL), "reaction-ledger.jsonl", [{ id: "react_aktuell", agentId: "bernhardine" }]);
      writeJsonl(join(workspaces, "bernhardine"), "episodes.jsonl", [episode("a")]);
      writeJsonl(join(workspaces, "bernhardine"), "reaction-ledger.jsonl", [{ id: "react_alt", agentId: "bernhardine" }]);

      const [plan] = planMigration(workspaces).plans;
      const report = migrateWorkspace(workspaces, plan, { apply: true, stamp: "capped" });

      assert.equal(report.reactions, undefined, "reactions darf gar nicht erst im Report auftauchen");
      assert.equal(report.behavior, undefined, "behavior darf gar nicht erst im Report auftauchen");
      assert.deepEqual(readEpisodeIds(workspaces).sort(), ["a", "c"], "Episoden werden sehr wohl migriert");

      const reactions = readFileSync(join(workspaces, CANONICAL, "reaction-ledger.jsonl"), "utf8");
      assert.match(reactions, /react_aktuell/);
      assert.doesNotMatch(reactions, /react_alt/, "Legacy-Reaktionen duerfen nicht uebernommen werden");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
