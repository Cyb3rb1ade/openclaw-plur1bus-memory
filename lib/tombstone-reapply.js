/**
 * lib/tombstone-reapply.js — wendet committed Tombstones erneut auf eine
 * (ggf. per Snapshot-Restore wiederhergestellte) LanceDB an.
 *
 * Gemeinsame Logik für `scripts/reapply-tombstones.mjs` und
 * `restoreSnapshot` (lib/snapshot/store-snapshot.js): Ein Restore bringt den
 * Zeilenstand des Snapshots zurück, die append-only Tombstone-Registry liegt
 * als Geschwister des Stores daneben und überlebt ihn. Ohne erneutes Einspielen
 * wäre jede nach dem Snapshot vergessene Erinnerung wieder aktiv und recallbar.
 *
 * Fail-closed: Registry-Lesefehler, beschädigte Registry-Zeilen, Schreib- und
 * Verifikationsfehler sowie nach dem Einspielen noch aktive Zeilen landen im
 * Report und machen `reapplyFailed(report)` wahr.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readTombstoneRegistry, tombstoneRegistryDir } from "./tombstone.js";
import { createDbAdapter } from "./db-adapter.js";
import { safeAgentId } from "./sql-safety.js";

/**
 * @typedef {object} ReapplyReport
 * @property {"apply"|"dry-run"} mode
 * @property {Array<object>} applied
 * @property {Array<object>} alreadyTombstoned
 * @property {Array<object>} notFound
 * @property {Array<object>} errors
 * @property {Array<object>} registryErrors
 * @property {Array<object>} activeAfterReapply
 */

/**
 * @param {{baseDbPath: string, apply?: boolean, adapterFactory?: (baseDbPath: string) => object}} opts
 *   `adapterFactory` ist ein Test-Haken; Standard ist `createDbAdapter` mit stummem Logger.
 * @returns {Promise<ReapplyReport>}
 */
export async function reapplyCommittedTombstones({ baseDbPath, apply = false, adapterFactory } = {}) {
  const registryDir = tombstoneRegistryDir(baseDbPath);

  // Alle Agents aus den Registry-Dateinamen ableiten.
  const agents = new Set();
  if (existsSync(registryDir)) {
    for (const file of readdirSync(registryDir)) {
      if (file.endsWith(".jsonl")) agents.add(file.slice(0, -".jsonl".length));
    }
  }

  const report = {
    mode: apply ? "apply" : "dry-run",
    applied: [],
    alreadyTombstoned: [],
    notFound: [],
    errors: [],
    registryErrors: [],
    activeAfterReapply: [],
  };
  const makeAdapter = adapterFactory
    ?? ((basePath) => createDbAdapter({ basePath, logger: { info() {}, warn() {} } }));

  for (const agent of agents) {
    let safeAgent;
    try { safeAgent = safeAgentId(agent); } catch {
      report.registryErrors.push({ agent, error: "invalid registry filename" });
      continue;
    }
    // Im Dry-Run strikt read-only: die Torn-Tail-Reparatur ist ein Schreibvorgang
    // und darf ohne apply nicht laufen. Ein abgebrochener Append wird dann als
    // beschädigte Zeile gemeldet — der Operator sieht, dass --apply nötig ist.
    const registry = readTombstoneRegistry(baseDbPath, safeAgent, { repairTornTail: apply });
    if (!registry.ok) {
      report.registryErrors.push({ agent: safeAgent, error: registry.readError });
      continue;
    }
    if (registry.corruptLines > 0) {
      // Fail-closed: beschädigte Zeilen könnten einen committed Tombstone
      // verbergen — das Restore darf nicht still "ok" melden.
      report.registryErrors.push({ agent: safeAgent, error: `corrupt registry lines: ${registry.corruptLines}` });
      continue;
    }
    const tombstones = registry.tombstones.filter((t) => t.status === "committed");
    if (tombstones.length === 0) continue;
    // Kein Store-Verzeichnis für diesen Agenten (z. B. Snapshot, der älter ist
    // als der Agent): es gibt keine Zeile, die wieder aufleben könnte. Ein
    // vorhandenes Verzeichnis, dessen Tabelle sich nicht öffnen lässt, bleibt
    // dagegen ein Fehler (fail-closed, unten).
    if (!existsSync(join(baseDbPath, safeAgent))) {
      for (const tombstone of tombstones) {
        if (tombstone.memoryId) report.notFound.push({ agent: safeAgent, memoryId: tombstone.memoryId });
      }
      continue;
    }
    const adapter = makeAdapter(baseDbPath);
    try {
      for (const tombstone of tombstones) {
        const id = tombstone.memoryId;
        if (!id) continue;
        if (!apply) {
          report.applied.push({ agent: safeAgent, memoryId: id, dryRun: true });
          continue;
        }
        try {
          const result = await adapter.tombstoneCard(safeAgent, id);
          if (result.alreadyTombstoned) report.alreadyTombstoned.push({ agent: safeAgent, memoryId: id });
          else if (result.notFound) report.notFound.push({ agent: safeAgent, memoryId: id });
          else report.applied.push({ agent: safeAgent, memoryId: id });
        } catch (err) {
          report.errors.push({ agent: safeAgent, memoryId: id, error: err?.message || String(err) });
        }
      }
      // Verifikation: keine durch committed Tombstone adressierte Zeile darf
      // recallbar/aktiv geblieben sein (Resurrection-Schutz). Verifikationsfehler
      // werden NICHT verschluckt — sie führen zum Fehlschlag. "active", "" und null
      // gelten als legacy-recallbar.
      for (const tombstone of tombstones) {
        const id = tombstone.memoryId;
        if (!id) continue;
        try {
          const row = await adapter.getCardRaw(safeAgent, id);
          if (row) {
            const status = String(row.status ?? "");
            if (status === "active" || status === "") {
              report.activeAfterReapply.push({ agent: safeAgent, memoryId: id, status });
            }
          }
        } catch (err) {
          report.errors.push({ agent: safeAgent, memoryId: id, error: `verify: ${err?.message || String(err)}` });
        }
      }
    } finally {
      await adapter.shutdown();
    }
  }
  return report;
}

/**
 * @param {ReapplyReport} report
 * @returns {boolean} true, wenn das Einspielen unvollständig oder unverifiziert ist.
 */
export function reapplyFailed(report) {
  return report.errors.length > 0 || report.registryErrors.length > 0 || report.activeAfterReapply.length > 0;
}
