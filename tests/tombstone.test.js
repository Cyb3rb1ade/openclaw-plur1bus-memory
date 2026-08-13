/**
 * tests/tombstone.test.js
 *
 * Negative Evals für den kanonischen Tombstone-/Forget-/Resurrection-Vertrag.
 * Verifiziert: kein physischer Delete, Scope-Bindung, Idempotenz,
 * Re-Capture-Block, kein Committed-Audit bei Fehlschlag.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TOMBSTONE_SCHEMA_VERSION,
  buildTombstone,
  tombstoneBlocksCapture,
  findBlockingTombstoneForCapture,
  findTombstoneByFingerprint,
  findTombstoneByOriginId,
  appendTombstoneToRegistry,
  readTombstonesFromRegistry,
  normalizeContentForFingerprint,
  contentFingerprint,
} from "../lib/tombstone.js";
import { forgetCard } from "../lib/telegram-commands/memory-edit.js";
import { createDbAdapter } from "../lib/db-adapter.js";
import { safeStatus } from "../lib/sql-safety.js";

const UUID_A = "11111111-1111-4111-8111-111111111111";

function makeTombstoneDb(cards = {}) {
  const store = new Map(Object.entries(cards).map(([id, c]) => [id, { ...c, id }]));
  const adapter = {
    calls: [],
    async getCard(_agent, id) { adapter.calls.push("getCard"); return store.get(id) || null; },
    async tombstoneCard(_agent, id) {
      adapter.calls.push("tombstoneCard");
      const c = store.get(id);
      if (!c) return { ok: false, notFound: true, id };
      if (c.status === "deleted") return { ok: true, alreadyTombstoned: true, id };
      c.status = "deleted";
      c.epistemicStatus = "invalidated";
      return { ok: true, id };
    },
    _store: store,
  };
  return adapter;
}

describe("Tombstone-Vertrag (buildTombstone)", () => {
  it("enthält alle Pflichtfelder und keinen Klartext", () => {
    const tombstone = buildTombstone({
      card: {
        id: UUID_A,
        text: "Mein geheimer API-Key ist abc123",
        scope: "agent-private",
        storedBy: "agent-a",
        sourceTurnId: "turn-1",
      },
      agentId: "agent-a",
      actor: "user",
      actorType: "human",
      reason: "user forgot",
      sourceOp: "forget",
      archiveRef: "/archive/x.json",
      previousVersion: "",
    });
    assert.equal(tombstone.schemaVersion, TOMBSTONE_SCHEMA_VERSION);
    assert.equal(tombstone.memoryId, UUID_A);
    assert.equal(tombstone.agentId, "agent-a");
    assert.equal(tombstone.scope, "agent-private");
    assert.equal(tombstone.status, "committed");
    assert.ok(tombstone.tombstoneId);
    assert.ok(tombstone.contentFingerprint);
    const json = JSON.stringify(tombstone);
    assert.doesNotMatch(json, /api-Key|abc123/i, "kein Klartext im Tombstone");
    assert.equal(tombstone.canonicalOriginId, UUID_A);
  });

  it("Fingerprint ist stabil und normalisiert", () => {
    assert.equal(
      contentFingerprint("  Hallo   WELT "),
      contentFingerprint("hallo welt"),
    );
    assert.notEqual(contentFingerprint("a"), contentFingerprint("b"));
  });
});

describe("Scope-Bindung (tombstoneBlocksCapture)", () => {
  const base = {
    schemaVersion: 1,
    memoryId: UUID_A,
    canonicalOriginId: UUID_A,
    agentId: "agent-a",
    status: "committed",
    contentFingerprint: "fp",
  };

  it("Agent A blockiert nicht Agent B", () => {
    assert.equal(tombstoneBlocksCapture({ ...base, scope: "agent-private" }, { agentId: "agent-b" }), false);
    assert.equal(tombstoneBlocksCapture({ ...base, scope: "agent-private" }, { agentId: "agent-a" }), true);
  });

  it("Workspace-Tombstone blockiert nur denselben Workspace", () => {
    const t = { ...base, scope: "workspace", workspaceId: "ws-1" };
    assert.equal(tombstoneBlocksCapture(t, { agentId: "agent-a", workspaceIdentity: "ws-2" }), false);
    assert.equal(tombstoneBlocksCapture(t, { agentId: "agent-a", workspaceIdentity: "ws-1" }), true);
  });

  it("User-Tombstone ist an den korrekten User gebunden", () => {
    const t = { ...base, scope: "user", ownerUserId: "user:v1:aaa" };
    assert.equal(tombstoneBlocksCapture(t, { agentId: "agent-a", ownerUserId: "user:v1:bbb" }), false);
    assert.equal(tombstoneBlocksCapture(t, { agentId: "agent-a", ownerUserId: "user:v1:aaa" }), true);
  });

  it("failed-Tombstone blockiert nicht", () => {
    assert.equal(tombstoneBlocksCapture({ ...base, status: "failed" }, { agentId: "agent-a" }), false);
  });
});

describe("Registry (append/read/find)", () => {
  it("append + find by fingerprint und origin, nur committed blockiert", () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-tombstone-reg-"));
    const baseDbPath = join(dir, "lancedb-namespaced");
    try {
      const tombstone = buildTombstone({
        card: { id: UUID_A, text: "Gelöschter Fakt", scope: "agent-private", storedBy: "agent-a" },
        agentId: "agent-a",
        actor: "user",
        actorType: "human",
        reason: "test",
        sourceOp: "forget",
      });
      appendTombstoneToRegistry(baseDbPath, "agent-a", { ...tombstone, status: "attempted" });
      assert.equal(findTombstoneByFingerprint(baseDbPath, "agent-a", tombstone.contentFingerprint), null, "attempted blockiert nicht");
      appendTombstoneToRegistry(baseDbPath, "agent-a", { ...tombstone, status: "committed" });
      const found = findTombstoneByFingerprint(baseDbPath, "agent-a", tombstone.contentFingerprint);
      assert.ok(found);
      assert.equal(found.status, "committed");
      assert.equal(findTombstoneByOriginId(baseDbPath, "agent-a", UUID_A).memoryId, UUID_A);
      assert.equal(readTombstonesFromRegistry(baseDbPath, "agent-a").length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("forgetCard kanonischer Vorgang", () => {
  it("tombstoned statt physisch zu löschen (Zeile bleibt, status=deleted)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-forget-card-"));
    const ws = join(dir, "ws");
    try {
      const db = makeTombstoneDb({ [UUID_A]: { text: "Geheim", title: "x", scope: "agent-private" } });
      const result = await forgetCard(db, "agent-a", UUID_A, { archiveDir: join(dir, "archive"), workspaceDir: ws });
      assert.equal(result.ok, true);
      assert.ok(db._store.has(UUID_A), "Zeile bleibt erhalten");
      assert.equal(db._store.get(UUID_A).status, "deleted");
      assert.equal(db._store.get(UUID_A).epistemicStatus, "invalidated");
      assert.ok(result.archivePath);
      // Commit-Audit genau einmal
      const auditPath = join(ws, ".adaptive-learning", "destructive-ops.jsonl");
      assert.ok(existsSync(auditPath), "Audit-Log existiert");
      const lines = readFileSync(auditPath, "utf8").trim().split("\n");
      const committed = lines.map((l) => JSON.parse(l)).filter((e) => e.event === "memory.deleted" && e.result === "committed");
      assert.equal(committed.length, 1, "genau ein Committed-Audit");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("wiederholtes Forget ist idempotent (keine zweite Löschung)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-forget-idem-"));
    try {
      const db = makeTombstoneDb({ [UUID_A]: { text: "x", title: "x", scope: "agent-private" } });
      const first = await forgetCard(db, "agent-a", UUID_A, { archiveDir: join(dir, "a") });
      const second = await forgetCard(db, "agent-a", UUID_A, { archiveDir: join(dir, "a") });
      assert.equal(first.ok, true);
      assert.equal(second.ok, true);
      assert.equal(second.alreadyTombstoned, true);
      assert.equal(db.calls.filter((c) => c === "tombstoneCard").length, 1, "nur eine Mutation");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fehlgeschlagene Persistierung erzeugt kein Committed-Audit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-forget-fail-"));
    const ws = join(dir, "ws");
    try {
      const db = {
        async getCard() { return { id: UUID_A, text: "x", scope: "agent-private" }; },
        async tombstoneCard() { throw new Error("db boom"); },
      };
      const result = await forgetCard(db, "agent-a", UUID_A, { archiveDir: join(dir, "a"), workspaceDir: ws });
      assert.equal(result.ok, false);
      const auditPath = join(ws, ".adaptive-learning", "destructive-ops.jsonl");
      assert.ok(existsSync(auditPath));
      const events = readFileSync(auditPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.equal(events.filter((e) => e.result === "committed").length, 0, "kein Committed bei Fehlschlag");
      assert.equal(events.filter((e) => e.result === "failed").length, 1, "Failed-Audit vorhanden");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("db-adapter tombstoneCard", () => {
  it("soft-deleted und idempotent; unbekannte Row → notFound", async () => {
    const rows = new Map([[UUID_A, { id: UUID_A, text: "x", status: "active" }]]);
    const fakeTable = {
      query() {
        return {
          _where: "",
          where(w) { this._where = w; return this; },
          limit() { return this; },
          async toArray() {
            const id = this._where.match(/id = "([0-9a-f-]+)"/)?.[1];
            return id && rows.has(id) ? [rows.get(id)] : [];
          },
        };
      },
      async update({ where, values }) {
        const id = where.match(/id = "([0-9a-f-]+)"/)?.[1];
        if (id && rows.has(id)) Object.assign(rows.get(id), values);
        return {};
      },
    };
    const adapter = createDbAdapter({ getTable: async () => fakeTable });
    const r1 = await adapter.tombstoneCard("agent", UUID_A);
    assert.equal(r1.ok, true);
    assert.equal(rows.get(UUID_A).status, "deleted");
    assert.equal(rows.get(UUID_A).epistemicStatus, "invalidated");
    const r2 = await adapter.tombstoneCard("agent", UUID_A);
    assert.equal(r2.alreadyTombstoned, true);
    const r3 = await adapter.tombstoneCard("agent", "99999999-9999-4999-8999-999999999999");
    assert.equal(r3.notFound, true);
  });
});

describe("Re-Capture-Block (findBlockingTombstoneForCapture)", () => {
  it("identischer normalisierter Inhalt wird im selben Scope blockiert", () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-recapture-"));
    const baseDbPath = join(dir, "lancedb-namespaced");
    try {
      const tombstone = buildTombstone({
        card: { id: UUID_A, text: "  Meine Adresse ist    Berlin ", scope: "agent-private", storedBy: "agent-a" },
        agentId: "agent-a",
        actor: "user",
        actorType: "human",
        reason: "test",
        sourceOp: "forget",
      });
      appendTombstoneToRegistry(baseDbPath, "agent-a", { ...tombstone, status: "committed" });
      const blocking = findBlockingTombstoneForCapture(baseDbPath, {
        agentId: "agent-a",
        text: "meine adresse ist berlin", // normalisiert identisch
        scope: "agent-private",
      });
      assert.ok(blocking, "identischer Inhalt muss blockiert werden");
      const foreign = findBlockingTombstoneForCapture(baseDbPath, {
        agentId: "agent-b",
        text: "meine adresse ist berlin",
        scope: "agent-private",
      });
      assert.equal(foreign, null, "fremder Agent nicht blockiert");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("safeStatus Fail-Closed", () => {
  it("unbekannte Statuswerte werden abgewiesen", () => {
    assert.equal(safeStatus("active"), "active");
    assert.equal(safeStatus("deleted"), "deleted");
    assert.throws(() => safeStatus("archvied"), /Invalid status/);
    assert.throws(() => safeStatus(""), /Invalid status/);
  });

  it("Normalisierung für Fingerprint kollabiert Whitespace", () => {
    assert.equal(normalizeContentForFingerprint("  a   b\nc  "), "a b c");
  });
});

// ─── Issue 2: Scope-Auflösung (alle Treffer, nicht nur der neueste) ─────────

describe("Scope-Auflösung (alle Treffer)", () => {
  function appendCommitted(baseDbPath, card, agentId, scope, workspaceKey = "", ownerUserId = "") {
    const tombstone = buildTombstone({
      card: { ...card, scope, workspaceKey, ownerUserId },
      agentId,
      actor: "user",
      actorType: "human",
      reason: "test",
      sourceOp: "forget",
    });
    appendTombstoneToRegistry(baseDbPath, agentId, { ...tombstone, status: "committed" });
    return tombstone;
  }

  it("mehrere gleichlautende Tombstones in verschiedenen Workspaces blockieren jeweils den richtigen Workspace", () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-scope-multi-"));
    const baseDbPath = join(dir, "lancedb-namespaced");
    try {
      const text = "Gelöschter Inhalt";
      appendCommitted(baseDbPath, { id: "aaaaaaaa-1111-4111-8111-111111111111", text }, "agent-a", "workspace", "ws-1");
      // neuerer Tombstone in einem ANDEREN Workspace darf den ws-1-Tombstone nicht verdecken
      appendCommitted(baseDbPath, { id: "bbbbbbbb-2222-4222-8222-222222222222", text }, "agent-a", "workspace", "ws-2");

      const blockingWs1 = findBlockingTombstoneForCapture(baseDbPath, { agentId: "agent-a", text, scope: "workspace", workspaceIdentity: "ws-1" });
      assert.ok(blockingWs1, "Capture in ws-1 muss durch den ws-1-Tombstone blockiert werden");
      assert.equal(blockingWs1.workspaceKey, "ws-1");

      const blockingWs2 = findBlockingTombstoneForCapture(baseDbPath, { agentId: "agent-a", text, scope: "workspace", workspaceIdentity: "ws-2" });
      assert.ok(blockingWs2, "Capture in ws-2 muss durch den ws-2-Tombstone blockiert werden");

      const foreign = findBlockingTombstoneForCapture(baseDbPath, { agentId: "agent-a", text, scope: "workspace", workspaceIdentity: "ws-3" });
      assert.equal(foreign, null, "fremder Workspace darf nicht blockiert werden");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("agent-private blockiert den ganzen Agenten, workspace/user nur ihren Principal", () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-scope-ap-"));
    const baseDbPath = join(dir, "lancedb-namespaced");
    try {
      const text = "Privater Fakt";
      appendCommitted(baseDbPath, { id: "aaaaaaaa-1111-4111-8111-111111111111", text }, "agent-a", "agent-private");
      assert.ok(findBlockingTombstoneForCapture(baseDbPath, { agentId: "agent-a", text, scope: "workspace", workspaceIdentity: "ws-1" }));
      assert.ok(findBlockingTombstoneForCapture(baseDbPath, { agentId: "agent-a", text, scope: "user", ownerUserId: "user:v1:aaa" }));
      assert.equal(findBlockingTombstoneForCapture(baseDbPath, { agentId: "agent-b", text, scope: "agent-private" }), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── Issue 3: Registry fail-safe ────────────────────────────────────────────

describe("Registry fail-safe", () => {
  it("beschädigte JSONL-Zeile blockiert Capture konservativ", () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-corrupt-"));
    const baseDbPath = join(dir, "lancedb-namespaced");
    const registryDir = join(dir, "_tombstones");
    try {
      const file = join(registryDir, "agent-a.jsonl");
      mkdirSync(registryDir, { recursive: true });
      writeFileSync(file, "NOT JSON AT ALL\n", "utf8");
      const blocking = findBlockingTombstoneForCapture(baseDbPath, { agentId: "agent-a", text: "irgendwas", scope: "agent-private" });
      assert.ok(blocking, "beschädigte Zeile muss konservativ blockieren");
      assert.equal(blocking._blockReason, "registry_corrupt_lines");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Lesefehler blockiert Capture konservativ statt still \"kein Tombstone\"", () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-readerr-"));
    const baseDbPath = join(dir, "lancedb-namespaced");
    const registryDir = join(dir, "_tombstones");
    try {
      // Registry-Datei als VERZEICHNIS anlegen → readFileSync wirft EISDIR.
      mkdirSync(join(registryDir, "agent-a.jsonl"), { recursive: true });
      const blocking = findBlockingTombstoneForCapture(baseDbPath, { agentId: "agent-a", text: "irgendwas", scope: "agent-private" });
      assert.ok(blocking, "Lesefehler muss konservativ blockieren");
      assert.equal(blocking._blockReason, "registry_read_error");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── Issue 4: Forget crash-recoverable + ACL vor Idempotenz ─────────────────

describe("Forget crash-recovery + ACL vor Idempotenz", () => {
  it("wiederholtes Forget einer bereits gelöschten Karte trägt fehlenden committed Tombstone nach", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-backfill-"));
    const baseDbPath = join(dir, "lancedb-namespaced");
    const ws = join(dir, "ws");
    try {
      const id = "aaaaaaaa-1111-4111-8111-111111111111";
      const db = {
        async getCard() { return { id, text: "x", scope: "agent-private", status: "deleted", previousVersion: "" }; },
        async tombstoneCard() { throw new Error("should not re-tombstone"); },
      };
      const result = await forgetCard(db, "agent-a", id, { archiveDir: join(dir, "a"), workspaceDir: ws, baseDbPath });
      assert.equal(result.ok, true);
      assert.equal(result.alreadyTombstoned, true);
      const backfilled = findTombstoneByOriginId(baseDbPath, "agent-a", id);
      assert.ok(backfilled, "fehlender committed Tombstone muss nachgetragen werden");
      assert.equal(backfilled.status, "committed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ACL wird vor der idempotenten Erfolgsauskunft geprüft (kein Information-Leak)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-acl-idem-"));
    try {
      const id = "aaaaaaaa-1111-4111-8111-111111111111";
      const db = {
        async getCard() { return { id, text: "x", scope: "agent-private", agentId: "other-agent", status: "deleted" }; },
        async tombstoneCard() { throw new Error("should not tombstone"); },
      };
      const result = await forgetCard(db, "agent-a", id, {
        archiveDir: join(dir, "a"),
        ctx: { agentId: "agent-a", workspaceDir: join(dir, "ws") },
      });
      assert.equal(result.ok, false);
      assert.match(result.error, /access denied/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
