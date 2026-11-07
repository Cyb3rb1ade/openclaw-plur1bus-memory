import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { resolveInside } from '../../lib/sql-safety.js';

/** Separate authoritative media collections; never opens or alters memories.lance.
 * @param {string} root Engine storage root.
 * @returns {object} Transactional media collections. */
export function openMediaStore(root) {
  const directory = resolveInside(root, 'media');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(resolveInside(directory, 'index.sqlite'));
  chmodSync(resolveInside(directory, 'index.sqlite'), 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS media_item (mediaId TEXT PRIMARY KEY, kind TEXT NOT NULL, mime TEXT NOT NULL,
      bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, createdAt INTEGER NOT NULL, captionMemoryId TEXT,
      state TEXT NOT NULL, agentId TEXT NOT NULL, scope TEXT NOT NULL, ownership TEXT NOT NULL, source BLOB NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS media_segment (mediaId TEXT NOT NULL, idx INTEGER NOT NULL, startMs REAL NOT NULL,
      endMs REAL NOT NULL, vector TEXT NOT NULL, dim INTEGER NOT NULL, PRIMARY KEY(mediaId, idx));
    CREATE TABLE IF NOT EXISTS media_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  const decode = row => row ? { ...row, ownership: JSON.parse(row.ownership) } : null;
  return {
    get: id => decode(db.prepare('SELECT * FROM media_item WHERE mediaId=?').get(id)),
    items: () => db.prepare('SELECT mediaId,kind,mime,bytes,sha256,createdAt,captionMemoryId,state,agentId,scope,ownership,attempts FROM media_item ORDER BY createdAt, mediaId').all().map(decode),
    segments: id => db.prepare('SELECT * FROM media_segment WHERE mediaId=? ORDER BY idx').all(id).map(row => ({ ...row, vector: JSON.parse(row.vector) })),
    meta: key => { const row = db.prepare('SELECT value FROM media_meta WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; },
    setMeta: (key, value) => db.prepare('INSERT OR REPLACE INTO media_meta VALUES (?,?)').run(key, JSON.stringify(value)),
    put(item, bytes) {
      db.prepare(`INSERT INTO media_item VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(mediaId) DO UPDATE SET
        kind=excluded.kind,mime=excluded.mime,bytes=excluded.bytes,sha256=excluded.sha256,state=excluded.state,source=excluded.source,attempts=0`).run(item.mediaId, item.kind, item.mime, bytes.length, item.sha256, item.createdAt, item.captionMemoryId || null, item.state, item.ownership.agentId, item.ownership.scope, JSON.stringify(item.ownership), bytes, 0);
    },
    patch(id, patch) {
      for (const key of ['state', 'captionMemoryId', 'attempts']) if (key in patch) db.prepare(`UPDATE media_item SET ${key}=? WHERE mediaId=?`).run(patch[key], id);
    },
    replaceSegments(id, segments, dim, validateReadback) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('DELETE FROM media_segment WHERE mediaId=?').run(id);
        for (const s of segments) db.prepare('INSERT INTO media_segment VALUES (?,?,?,?,?,?)').run(id, s.idx, s.startMs, s.endMs, JSON.stringify(s.vector), dim);
        validateReadback?.();
        db.prepare("UPDATE media_item SET state='indexed' WHERE mediaId=?").run(id);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    invalidate() { db.exec("DELETE FROM media_segment; UPDATE media_item SET state='pending', attempts=0"); },
    remove(id) { db.exec('BEGIN IMMEDIATE'); try { db.prepare('DELETE FROM media_segment WHERE mediaId=?').run(id); db.prepare('DELETE FROM media_item WHERE mediaId=?').run(id); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; } },
    close: () => db.close(),
  };
}
