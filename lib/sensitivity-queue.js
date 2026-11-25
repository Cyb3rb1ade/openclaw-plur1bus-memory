/**
 * lib/sensitivity-queue.js — LLM verdicts on how private a memory is, and
 * the background queue that produces them (7.21.2).
 *
 * A foreign memory that would be shown in a group needs an LLM verdict on
 * its sensitivity. Without one it is held back on its first appearance and
 * queued here; a timer classifies the queue in batches with one LLM call per
 * batch, outside any turn and outside the recall budget. Verdicts go to an
 * append-only sidecar (`{baseDbPath}/_sensitivity/verdicts.jsonl`, id →
 * level); the memory rows themselves are never written. The queue lives in
 * memory only (a restart forgets it; the next appearance queues again), so no
 * memory text is copied to disk.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeSensitivity } from "./sensitivity.js";

/** Most items waiting at once (oldest dropped first). */
export const SENSITIVITY_QUEUE_MAX = 500;
/** Items per LLM call. */
export const SENSITIVITY_BATCH_DEFAULT = 20;
/** Characters of memory text shown to the classifier per item. */
export const SENSITIVITY_TEXT_MAX = 600;

const SYSTEM_PROMPT = `Du stufst Erinnerungen eines persönlichen Assistenten danach ein, ob sie in einem anderen Chat (z. B. einer Gruppe) erwähnt werden dürfen.
"confidential": Gesundheit, Finanzen, Beziehung/Intimes, Familienkonflikte, Adressen/Zugangsdaten, Rechtliches.
"personal": Persönliches, aber harmlos (Essen, Hobbys, Stimmung, Pläne).
"banal": alles andere.
Antworte ausschließlich mit JSON: {"<id>": "banal"|"personal"|"confidential", ...}`;

/**
 * @param {{baseDir: string, logger?: object, now?: () => number}} opts
 * @returns {object} store with lookup, enqueue, pending, processBatch
 */
export function createSensitivityStore({ baseDir, logger = null, now = Date.now } = {}) {
  const dir = baseDir ? join(baseDir, "_sensitivity") : "";
  const file = dir ? join(dir, "verdicts.jsonl") : "";
  const verdicts = new Map();
  const queue = new Map();
  let loaded = false;
  let running = false;

  const load = () => {
    if (loaded) return;
    loaded = true;
    if (!file || !existsSync(file)) return;
    try {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          const level = normalizeSensitivity(row?.sensitivity);
          if (row?.id && level) verdicts.set(String(row.id), { sensitivity: level, source: "llm", at: row.at });
        } catch { /* skip a broken line */ }
      }
    } catch (error) {
      logger?.warn?.(`plur1bus-sensitivity: verdicts unreadable: ${String(error?.message || error)}`);
    }
  };

  return {
    /** @param {string} id @returns {{sensitivity: string, source: string}|null} */
    lookup(id) {
      load();
      return verdicts.get(String(id)) || null;
    },
    /**
     * Queue a memory for classification (deduplicated, bounded).
     * @param {{id?: string, text?: string, summary?: string, statement?: string}} entry
     * @param {string} [agentId]
     * @returns {boolean} whether it was newly queued
     */
    enqueue(entry, agentId = "") {
      load();
      const id = entry?.id ? String(entry.id) : "";
      if (!id || verdicts.has(id) || queue.has(id)) return false;
      const text = String(entry?.text || entry?.statement || entry?.summary || "").slice(0, SENSITIVITY_TEXT_MAX);
      if (!text.trim()) return false;
      queue.set(id, { id, text, agentId, enqueuedAt: now() });
      while (queue.size > SENSITIVITY_QUEUE_MAX) queue.delete(queue.keys().next().value);
      return true;
    },
    pending: () => queue.size,
    /**
     * Classify up to `batchSize` queued items with one LLM call.
     * @param {{complete: (messages: object[], agentId: string) => Promise<string>, batchSize?: number}} args
     *   One call per batch; a batch holds items of one agent only.
     * @returns {Promise<{classified: number, failed: number, skipped: boolean}>}
     */
    async processBatch({ complete, batchSize = SENSITIVITY_BATCH_DEFAULT } = {}) {
      if (running || queue.size === 0 || typeof complete !== "function") return { classified: 0, failed: 0, skipped: true };
      running = true;
      // Ein Aufruf je Agent: die LLM-Route des Hosts braucht einen echten
      // Agenten (Modellwahl, Inferenz-Konto).
      const first = queue.values().next().value;
      const batch = [...queue.values()].filter((item) => item.agentId === first.agentId).slice(0, Math.max(1, batchSize));
      try {
        const listing = batch.map((item) => `[${item.id}] ${item.text.replace(/\s+/g, " ")}`).join("\n");
        const raw = await complete([
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: listing },
        ], first.agentId);
        const json = String(raw || "").match(/\{[\s\S]*\}/)?.[0];
        const parsed = json ? JSON.parse(json) : {};
        let classified = 0;
        const lines = [];
        for (const item of batch) {
          const level = normalizeSensitivity(parsed?.[item.id]);
          queue.delete(item.id);
          if (!level) continue;
          verdicts.set(item.id, { sensitivity: level, source: "llm", at: now() });
          lines.push(JSON.stringify({ id: item.id, sensitivity: level, at: now() }));
          classified++;
        }
        if (lines.length && dir) {
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          appendFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
        }
        logger?.info?.(`plur1bus-sensitivity: classified ${classified}/${batch.length} queued memories (pending ${queue.size})`);
        return { classified, failed: batch.length - classified, skipped: false };
      } catch (error) {
        // Bleiben in der Warteschlange; nächster Lauf versucht es erneut.
        logger?.warn?.(`plur1bus-sensitivity: classification failed: ${String(error?.message || error).slice(0, 200)}`);
        return { classified: 0, failed: batch.length, skipped: false };
      } finally {
        running = false;
      }
    },
  };
}
