/**
 * lib/garbage-collector.js — Garbage Collection für das PLUR1BUS Memory-System (v6).
 *
 * Bietet Funktionen zur Auswahl und Archivierung schwacher/alter Memories,
 * um die LanceDB-Größe pro Agent in Grenzen zu halten.
 *
 * Constraints:
 *   - Memories werden archiviert (status = "archived"), NICHT hart gelöscht.
 *   - Vor der Archivierung wird ein JSON-Backup geschrieben.
 *   - Idempotent: bereits archivierte Memories werden übersprungen.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Schätzt die Größe einer LanceDB-Agent-Datenbank in Bytes.
 *
 * @param {string} dbPath — absoluter Pfad zum Agent-DB-Verzeichnis
 * @returns {number} Gesamtgröße in Bytes (nur Dateien, keine Symlinks)
 */
export function getDbSize(dbPath) {
  if (!dbPath || !existsSync(dbPath)) return 0;
  let total = 0;
  try {
    for (const entry of readdirSync(dbPath, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      if (name === "." || name === "..") continue;
      const filePath = join(dbPath, name);
      let st;
      try {
        st = lstatSync(filePath);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      total += st.size;
    }
  } catch {
    return 0;
  }
  return total;
}

function isActiveMemory(m) {
  return m && m.status !== "archived" && m.status !== "deleted";
}

function memoryPriorityScore(m) {
  const strength = typeof m.memoryStrength === "number" ? m.memoryStrength : 1.0;
  const age = typeof m.createdAt === "number" ? m.createdAt : Date.now();
  const sharedPenalty = m.scope === "shared" ? 1 : 0;
  // Schwäche = niedriger score = zuerst
  // Alter = niedriger timestamp = zuerst
  // Nicht-geteilt = sharedPenalty 0 = zuerst (da strength gleich)
  return { strength, age, sharedPenalty };
}

function sortByPriority(a, b) {
  const sa = memoryPriorityScore(a);
  const sb = memoryPriorityScore(b);
  if (sa.strength !== sb.strength) return sa.strength - sb.strength;
  if (sa.age !== sb.age) return sa.age - sb.age;
  return sa.sharedPenalty - sb.sharedPenalty;
}

/**
 * Wählt Memories für die Archivierung basierend auf einer Policy aus.
 *
 * Policy-Optionen:
 *   - maxDbSizeMb: Wenn dbSizeMb > maxDbSizeMb → archiviere bis unter Limit
 *   - maxMemoryCount: Wenn mehr als X active Memories → älteste/schwächste
 *   - minMemoryStrength: Archiviere Memories mit Stärke < X
 *
 * @param {Array<object>} memories — Array von Memory-Objekten
 * @param {object} policy
 * @param {number} [policy.maxDbSizeMb]
 * @param {number} [policy.dbSizeMb] — aktuelle DB-Größe in MB (erforderlich für maxDbSizeMb)
 * @param {number} [policy.maxMemoryCount]
 * @param {number} [policy.minMemoryStrength]
 * @returns {string[]} Array von Memory-IDs die archiviert werden sollen
 */
export function selectCandidatesForGc(memories, policy = {}) {
  const list = Array.isArray(memories) ? memories : [];
  const active = list.filter(isActiveMemory);
  if (active.length === 0) return [];

  const candidates = new Set();

  // 1. minMemoryStrength — unabhängig, immer anwenden wenn gesetzt
  if (typeof policy.minMemoryStrength === "number") {
    for (const m of active) {
      const strength = typeof m.memoryStrength === "number" ? m.memoryStrength : 1.0;
      if (strength < policy.minMemoryStrength) {
        candidates.add(m.id);
      }
    }
  }

  let targetRemoveCount = 0;

  // 2. maxDbSizeMb
  if (typeof policy.maxDbSizeMb === "number" && typeof policy.dbSizeMb === "number" && policy.dbSizeMb > policy.maxDbSizeMb) {
    const avgSizeMb = Math.max(policy.dbSizeMb / active.length, 0.0001);
    const excessMb = policy.dbSizeMb - policy.maxDbSizeMb;
    const count = Math.ceil(excessMb / avgSizeMb);
    targetRemoveCount = Math.max(targetRemoveCount, count);
  }

  // 3. maxMemoryCount
  if (typeof policy.maxMemoryCount === "number" && active.length > policy.maxMemoryCount) {
    targetRemoveCount = Math.max(targetRemoveCount, active.length - policy.maxMemoryCount);
  }

  if (targetRemoveCount > 0) {
    const sorted = active.slice().sort(sortByPriority);
    for (let i = 0; i < targetRemoveCount && i < sorted.length; i++) {
      candidates.add(sorted[i].id);
    }
  }

  return Array.from(candidates);
}

/**
 * Archiviert Memories: schreibt JSON-Backup und setzt status auf "archived".
 *
 * @param {object} db — MemoryDB-ähnliches Objekt mit getById(id) und update(id, patch)
 * @param {string[]} memoryIds — zu archivierende IDs
 * @param {string} archiveDir — absoluter Pfad zum Archiv-Verzeichnis
 * @returns {Promise<{archived:number, skipped:number}>}
 */
export async function archiveMemories(db, memoryIds, archiveDir) {
  if (!db || !Array.isArray(memoryIds) || memoryIds.length === 0) {
    return { archived: 0, skipped: 0 };
  }
  if (!existsSync(archiveDir)) {
    mkdirSync(archiveDir, { recursive: true });
  }

  let archived = 0;
  let skipped = 0;

  for (const id of memoryIds) {
    let memory;
    try {
      memory = await db.getById(id);
    } catch {
      skipped++;
      continue;
    }
    if (!memory || memory.status === "archived" || memory.status === "deleted") {
      skipped++;
      continue;
    }

    const timestamp = Date.now();
    const backupPath = join(archiveDir, `memory-${id}-${timestamp}.json`);
    try {
      writeFileSync(backupPath, JSON.stringify(memory, null, 2), "utf8");
    } catch {
      skipped++;
      continue;
    }

    try {
      await db.update(id, { status: "archived" });
      archived++;
    } catch {
      skipped++;
    }
  }

  return { archived, skipped };
}
