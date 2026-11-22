/** Persistent per-agent recall counters. No query or memory text is stored. */
import { DatabaseSync } from 'node:sqlite';
import { createHmac, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { validateInput } from '../../lib/input-limits.js';
import { resolveInside, safeAgentId, safeUuid } from '../../lib/sql-safety.js';

/**
 * The first read/write migrates schema 0 to 1 without changing memory rows.
 * Each transaction has its own connection; SQLite serializes concurrent writers.
 * @param {{baseDbPath: string}} deps
 * @returns {{path: Function, record: Function, read: Function}}
 */
export function createRecallStats({ baseDbPath }) {
  const path = agentId => resolveInside(baseDbPath, '_recall-stats', `${safeAgentId(agentId)}.sqlite`);
  function withDb(agentId, run) {
    const file = path(agentId);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(file);
    try {
      chmodSync(file, 0o600);
      db.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
      const version = db.prepare('PRAGMA user_version').get().user_version;
      if (version > 1) throw new Error('unsupported recall stats schema');
      db.exec(`CREATE TABLE IF NOT EXISTS stats (id TEXT PRIMARY KEY, recalls INTEGER NOT NULL DEFAULT 0, lastRecalledAt INTEGER);
        CREATE TABLE IF NOT EXISTS queries (id TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(id, digest));
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
      db.prepare('INSERT OR IGNORE INTO metadata VALUES (?, ?)').run('query-hmac-key', randomBytes(32).toString('hex'));
      db.exec('PRAGMA user_version = 1');
      const out = run(db);
      db.exec('COMMIT');
      return out;
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    } finally { db.close(); }
  }
  return {
    path,
    /** Count each unique returned card once for this recall; query equality is exact. */
    record(agentId, ids, query, now = Date.now()) {
      const unique = [...new Set(ids.map(safeUuid))];
      if (!unique.length) return;
      const input = validateInput(query, { name: 'query', maxLength: 1_000_000, required: true });
      if (!input.ok || typeof query !== 'string') throw new Error('invalid recall query');
      if (!Number.isSafeInteger(now) || now < 0) throw new Error('invalid recall timestamp');
      withDb(agentId, db => {
        const key = db.prepare('SELECT value FROM metadata WHERE key = ?').get('query-hmac-key').value;
        const digest = createHmac('sha256', key).update(query).digest('hex');
        for (const id of unique) {
          db.prepare(`INSERT INTO stats VALUES (?, 1, ?) ON CONFLICT(id) DO UPDATE SET recalls = recalls + 1, lastRecalledAt = MAX(lastRecalledAt, excluded.lastRecalledAt)`).run(id, now);
          db.prepare('INSERT OR IGNORE INTO queries VALUES (?, ?)').run(id, digest);
        }
      });
    },
    /** Missing counters are explicit zeros; absent ids returns all persisted ids. */
    read(agentId, ids) {
      const safeIds = ids == null ? null : [...new Set(ids.map(safeUuid))];
      return withDb(agentId, db => {
        const keys = safeIds ?? db.prepare('SELECT id FROM stats ORDER BY id').all().map(row => row.id);
        return keys.map(id => {
          const row = db.prepare('SELECT recalls, lastRecalledAt FROM stats WHERE id = ?').get(id);
          const distinct = db.prepare('SELECT COUNT(*) AS n FROM queries WHERE id = ?').get(id).n;
          return { id, recalls: row?.recalls ?? 0, distinctQueries: distinct, lastRecalledAt: row?.lastRecalledAt ?? null };
        });
      });
    },
  };
}
