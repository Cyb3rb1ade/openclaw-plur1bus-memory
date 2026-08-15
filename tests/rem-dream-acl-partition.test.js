/**
 * tests/rem-dream-acl-partition.test.js
 *
 * R1: Der rem-dream-Aufrufer baute die ACL-Partition ausschließlich als `user`
 * (wenn userPrincipal vorhanden) oder `workspace` — nie `agent-private`.
 *
 * loadCandidateMemories filtert am Ende über
 * `sameRemBindings(remBindings(r, ctx), aclPartition)`, und das vergleicht
 * `a.scope === b.scope`. Live gemessen (15.08.2026, read-only): von den Zeilen im
 * Wochenfenster, die alle übrigen Filter passieren, sind 70/70 (bernhardine) und
 * 49/49 (main) `agent-private`. Sie trafen nie auf die gebaute Partition — jede
 * Zeile fiel raus, der Job meldete dauerhaft
 * `{"skipped":true,"reason":"too_few_memories","count":0}`.
 *
 * Das ist die tatsächliche Ursache des Live-Ausfalls. Der Schema-Drift-Fix in
 * #108 härtet einen anderen Pfad und behebt sie NICHT: die deployte 7.2.6
 * referenziert `epistemicStatus` in der where-Klausel gar nicht.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import * as lancedb from "@lancedb/lancedb";

import { buildRemPartition, buildRemPartitions, loadCandidateMemories } from "../lib/dreaming/rem-dream.js";

const AGENT = "partition-agent";
const USER_PRINCIPAL = `user:v1:${"a".repeat(64)}`;

// Workspace-Identitäten sind kanonisiert (`workspace:v1:<key>`) und werden gegen
// den Alias-Snapshot aufgelöst — mit leerem Snapshot kanonisiert
// canonicalStoredWorkspace zu "" und die Partition liesse sich gar nicht bauen.
const WORKSPACE_ALIASES = Object.freeze({
  paths: Object.freeze([]),
  aliases: Object.freeze([{ alias: "workspace-a", workspaceKey: "canonical-a" }]),
});
const WORKSPACE_IDENTITY = "workspace:v1:canonical-a";

describe("buildRemPartitions", () => {
  it("enthält immer eine agent-private-Partition", () => {
    const partitionen = buildRemPartitions({
      agentId: AGENT,
      workspaceIdentity: WORKSPACE_IDENTITY,
      workspaceAliases: WORKSPACE_ALIASES,
    });

    const scopes = partitionen.map((p) => p.scope);
    assert.ok(
      scopes.includes("agent-private"),
      `dort liegen faktisch alle Erinnerungen — bekam: ${JSON.stringify(scopes)}`,
    );
  });

  it("nimmt die Workspace-Partition zusätzlich auf, nicht anstelle", () => {
    const scopes = buildRemPartitions({
      agentId: AGENT,
      workspaceIdentity: WORKSPACE_IDENTITY,
      workspaceAliases: WORKSPACE_ALIASES,
    }).map((p) => p.scope);

    assert.deepEqual(scopes, ["agent-private", "workspace"]);
  });

  it("nimmt die User-Partition auf, wenn ein Principal vorliegt", () => {
    const scopes = buildRemPartitions({
      agentId: AGENT,
      userPrincipal: USER_PRINCIPAL,
      workspaceAliases: WORKSPACE_ALIASES,
    }).map((p) => p.scope);

    assert.deepEqual(scopes, ["agent-private", "user"]);
  });

  it("liefert für jede Partition einen eigenen Run-Key-tauglichen Schlüssel", () => {
    const partitionen = buildRemPartitions({
      agentId: AGENT,
      workspaceIdentity: WORKSPACE_IDENTITY,
      workspaceAliases: WORKSPACE_ALIASES,
    });

    const keys = partitionen.map((p) => p.key);
    assert.equal(new Set(keys).size, keys.length, "gleiche Schlüssel würden Läufe gegenseitig deduplizieren");
    for (const key of keys) assert.match(String(key), /^[0-9a-f]{20}$/);
  });

  it("liefert eine leere Liste, wenn kein Agent bestimmbar ist", () => {
    assert.deepEqual(buildRemPartitions({ workspaceAliases: WORKSPACE_ALIASES }), []);
  });
});

describe("buildRemPartitions gegen echte agent-private Zeilen", () => {
  const TAG = 86_400_000;

  /** Tabelle in der Live-Form: agent-private Zeilen im Wochenfenster. */
  async function agentPrivateTable(t) {
    const dir = mkdtempSync(join(tmpdir(), "rem-partition-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const jetzt = Date.now();
    const rows = [0, 1, 2].map((i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      text: `Erinnerung ${i}`,
      summary: "",
      vector: Array(8).fill(0.1),
      status: "active",
      category: "project_fact",
      memoryClass: "standard",
      createdAt: jetzt - TAG,
      sourceTimestamp: jetzt - TAG,
      workspaceId: "",
      workspaceKey: "",
      agentId: AGENT,
      storedBy: AGENT,
      scope: "agent-private",
      ownerUserId: "",
    }));
    const db = await lancedb.connect(dir);
    return await db.createTable("memories", rows);
  }

  const ctx = () => ({
    agentId: AGENT,
    workspaceIdentity: WORKSPACE_IDENTITY,
    workspaceAliases: WORKSPACE_ALIASES,
  });

  it("die erste Partition passt auf echte agent-private Zeilen", async (t) => {
    const table = await agentPrivateTable(t);
    const requestContext = ctx();

    const memories = await loadCandidateMemories({ table }, {
      weekStartMs: Date.now() - 7 * TAG,
      requestContext,
      aclPartition: buildRemPartitions(requestContext)[0],
      maxMemories: 5000,
    });

    assert.equal(memories.length, 3, "agent-private Kandidaten müssen die ACL-Grenze passieren");
  });

  it("mit der alten workspace-Partition bleibt exakt dieselbe Tabelle leer", async (t) => {
    const table = await agentPrivateTable(t);
    const requestContext = ctx();

    // Das war das Verhalten vor dem Fix: Partition workspace, Zeilen
    // agent-private — sameRemBindings vergleicht `a.scope === b.scope`.
    const memories = await loadCandidateMemories({ table }, {
      weekStartMs: Date.now() - 7 * TAG,
      requestContext,
      aclPartition: buildRemPartition(
        { scope: "workspace", agentId: AGENT, workspaceIdentity: WORKSPACE_IDENTITY, ownerUserId: "" },
        requestContext,
      ),
      maxMemories: 5000,
    });

    assert.equal(memories.length, 0, "genau so entstand live `too_few_memories, count: 0`");
  });
});
