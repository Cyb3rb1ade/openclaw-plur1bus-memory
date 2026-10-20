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
import { appendTombstoneToRegistry, readTombstoneRegistry, tombstoneRegistryDir } from "./tombstone.js";
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

/** Ein `attempted` ohne Commit, dessen Zeile noch aktiv ist, gilt nach dieser Frist als abgebrochen. */
export const ATTEMPTED_GRACE_MS = 10 * 60_000;

function registryAgents(baseDbPath) {
  const dir = tombstoneRegistryDir(baseDbPath);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -".jsonl".length));
}

/**
 * Startup-/Recovery-Reconcile für Tombstones im Zustand `attempted`.
 *
 * /forget ist zweiphasig: attempted -> Soft-Delete der Zeile -> committed. Ein
 * Absturz dazwischen hinterlässt einen `attempted`-Tombstone neben einer bereits
 * gelöschten Zeile; `attempted` blockiert keine Neuerfassung, der vergessene Text
 * könnte also wieder gespeichert werden. Je offenem Versuch (letzter Status je
 * `tombstoneId` ist `attempted`, für die Erinnerung gibt es keinen committed
 * Tombstone):
 *
 *   - Zeile `deleted`  -> `committed` mit derselben `tombstoneId` nachtragen;
 *   - Zeile noch aktiv -> die Löschung ist nie passiert: jünger als `graceMs` bleibt
 *     der Versuch unberührt (`pending`, er könnte in einem anderen Prozess noch laufen),
 *     älter wird `failed` angehängt (`abandoned`); nie `committed`;
 *   - Zeile fehlt / Agent-Store fehlt -> nichts schreiben (`rowMissing`);
 *   - Lesefehler -> `errors`, nichts schreiben (kein Commit und kein Fail auf Verdacht).
 *
 * Idempotent. Das umgekehrte Muster (committed, Zeile aktiv) behebt
 * `reapplyCommittedTombstones`.
 *
 * @param {{baseDbPath: string, storeRoot?: string, adapter: {getCardRaw: (agent: string, id: string) => Promise<object|null>}, now?: number, graceMs?: number, logger?: {info?: Function, warn?: Function}}} opts
 * `baseDbPath` locates the registry (`_tombstones/` next to it); `storeRoot` is where the
 * agents' LanceDB directories live (the adapter's root; differs from `baseDbPath` while a
 * re-embedding generation is active). Default: `baseDbPath`.
 * @returns {Promise<{committed: object[], abandoned: object[], pending: object[], rowMissing: object[], errors: object[], registryErrors: object[]}>}
 */
export async function reconcileAttemptedTombstones({ baseDbPath, storeRoot = baseDbPath, adapter, now = Date.now(), graceMs = ATTEMPTED_GRACE_MS, logger } = {}) {
  const report = { committed: [], abandoned: [], pending: [], rowMissing: [], errors: [], registryErrors: [] };
  for (const agent of registryAgents(baseDbPath)) {
    let safeAgent;
    try { safeAgent = safeAgentId(agent); } catch {
      report.registryErrors.push({ agent, error: "invalid registry filename" });
      continue;
    }
    const registry = readTombstoneRegistry(baseDbPath, safeAgent);
    if (!registry.ok) {
      report.registryErrors.push({ agent: safeAgent, error: registry.readError });
      continue;
    }
    if (registry.corruptLines > 0) {
      report.registryErrors.push({ agent: safeAgent, error: `corrupt registry lines: ${registry.corruptLines}` });
      continue;
    }
    const lastById = new Map();
    for (const t of registry.tombstones) lastById.set(t.tombstoneId ?? `${t.memoryId}:${t.deletedAt}`, t);
    const committedMemories = new Set(registry.tombstones.filter((t) => t.status === "committed").map((t) => t.memoryId));
    const open = [...lastById.values()].filter((t) => t.status === "attempted" && !committedMemories.has(t.memoryId));
    if (open.length === 0) continue;
    if (!existsSync(join(storeRoot, safeAgent))) {
      for (const t of open) report.rowMissing.push({ agent: safeAgent, memoryId: t.memoryId });
      continue;
    }
    for (const t of open) {
      const entry = { agent: safeAgent, memoryId: t.memoryId, tombstoneId: t.tombstoneId };
      try {
        const row = await adapter.getCardRaw(safeAgent, t.memoryId);
        if (!row) {
          report.rowMissing.push(entry);
        } else if (String(row.status ?? "") === "deleted") {
          appendTombstoneToRegistry(baseDbPath, safeAgent, { ...t, status: "committed" });
          report.committed.push(entry);
          logger?.info?.(`tombstone reconcile: committed interrupted forget of ${t.memoryId} (agent ${safeAgent})`);
        } else {
          const age = now - Date.parse(t.deletedAt);
          if (Number.isFinite(age) && age < graceMs) {
            report.pending.push(entry);
          } else {
            appendTombstoneToRegistry(baseDbPath, safeAgent, { ...t, status: "failed" });
            report.abandoned.push(entry);
            logger?.info?.(`tombstone reconcile: forget of ${t.memoryId} never happened, marked failed (agent ${safeAgent})`);
          }
        }
      } catch (err) {
        report.errors.push({ ...entry, error: err?.message || String(err) });
      }
    }
  }
  return report;
}
