/**
 * tests/dream-memory-recall.test.js
 *
 * Traum-Memories im Recall: 🌙-Kennzeichnung im Prompt-Formatter,
 * Feedback-Spiralen-Guards (kein Strengthening von Träumen, Träume sind
 * kein REM-Material) und kurze Halbwertszeit für memoryClass "dream".
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { formatRelevantMemoriesContext } from "../lib/relevant-memory-context.js";
import { lightDream } from "../lib/dreaming/light-dream.js";
import { buildRemPartition, loadCandidateMemories } from "../lib/dreaming/rem-dream.js";
import { resolveHalfLifeDays } from "../lib/memory-dynamics.js";

describe("Recall-Kennzeichnung für Träume", () => {
  it("memoryClass dream bekommt 🌙-Präfix, Datum und Fiktions-Hinweis", () => {
    const out = formatRelevantMemoriesContext([
      {
        id: "d1",
        category: "other",
        source: "dream",
        display: "Ich gehe durch einen Flur aus alten Commits.",
        memoryClass: "dream",
        createdAt: Date.UTC(2026, 6, 12),
        memoryStrength: 1.0,
      },
      {
        id: "f1",
        category: "fact",
        source: "memory",
        display: "Bernd nutzt LanceDB.",
        memoryClass: "standard",
        createdAt: Date.UTC(2026, 6, 12),
        memoryStrength: 1.0,
      },
    ]);
    assert.match(out, /🌙 \[Traum vom 2026-07-12\]/, "Traum-Präfix mit Datum fehlt");
    assert.match(out, /\(geträumt, nicht geschehen\)/, "Fiktions-Hinweis fehlt");
    assert.match(out, /memory-class="dream" fictional="true"/, "dream-Attribute fehlen");
    assert.ok(!/🌙 \[Traum[^\]]*\] Bernd nutzt LanceDB/.test(out), "Normale Memory darf nicht als Traum markiert werden");
  });
});

describe("Feedback-Spiralen-Guards", () => {
  it("lightDream verstärkt aktivierte Traum-Memories nicht", async () => {
    const strengthenedIds = [];
    const db = {
      search: async () => [
        { entry: { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", memoryClass: "dream" }, score: 0.9 },
        { entry: { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", memoryClass: "standard" }, score: 0.8 },
      ],
      table: {
        query: () => ({ where: () => ({ limit: () => ({ toArray: async () => [{ id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", replayCount: 0 }] }) }) }),
        update: async ({ where }) => { strengthenedIds.push(where); },
      },
    };
    const result = await lightDream({
      turns: [
        { role: "user", content: "Bitte denk daran, dass wir immer LanceDB für Vektoren nutzen wollen." },
        { role: "assistant", content: "Verstanden, ich merke mir das." },
        { role: "user", content: "Gut, dann bis morgen." },
      ],
      neoStore: { appendDreams: () => {}, appendBehaviorCards: () => {}, readReactions: () => [] },
      db,
      embeddings: { embed: async () => [0.1, 0.2] },
      insightLlmCfg: { model: "test" },
      callLlm: async () => JSON.stringify(["Bernd will LanceDB für Vektoren nutzen"]),
    });
    assert.strictEqual(result.strengthenedCount, 1, "nur die Nicht-Traum-Memory darf verstärkt werden");
    assert.strictEqual(strengthenedIds.length, 1);
    assert.match(strengthenedIds[0], /bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/);
  });

  it("REM-Kandidatenladung filtert Traum-Memories aus (keine Traum-aus-Traum-Rekursion)", async () => {
    const now = Date.now();
    const context = {
      agentId: "dream-agent",
      workspaceIdentity: "workspace:v1:dream-workspace",
      workspaceAliases: { paths: [], aliases: [] },
    };
    const rows = [
      { id: "m1", text: "echte Erinnerung", vector: [0.1], createdAt: now, status: "active", memoryClass: "standard", scope: "agent-private", agentId: "dream-agent" },
      { id: "d1", text: "geträumter Flur", vector: [0.2], createdAt: now, status: "active", memoryClass: "dream", scope: "agent-private", agentId: "dream-agent" },
    ];
    const db = {
      table: {
        schema: async () => ({ fields: [
          { name: "id" }, { name: "text" }, { name: "scope" }, { name: "agentId" },
          { name: "workspaceKey" }, { name: "createdAt" }, { name: "status" }, { name: "memoryClass" },
        ] }),
        query: () => {
          let offset = 0;
          let limit = rows.length;
          const builder = {
            where: () => builder,
            offset: (value) => { offset = value; return builder; },
            limit: (value) => { limit = value; return builder; },
            toArray: async () => rows.slice(offset, offset + limit),
          };
          return builder;
        },
      },
    };
    const memories = await loadCandidateMemories(db, {
      weekStartMs: now - 1000,
      requestContext: context,
      aclPartition: buildRemPartition({ scope: "agent-private", agentId: "dream-agent", workspaceIdentity: "", ownerUserId: "" }, context),
    });
    assert.deepStrictEqual(memories.map((m) => m.id), ["m1"]);
  });
});

describe("Halbwertszeit für Träume", () => {
  it("memoryClass dream → 30 Tage, überschreibbar via overrides.dream", () => {
    assert.strictEqual(resolveHalfLifeDays("other", "dream"), 30);
    assert.strictEqual(resolveHalfLifeDays("other", "dream", { dream: 14 }), 14);
    // Normale Klassen bleiben unberührt
    assert.strictEqual(resolveHalfLifeDays("other", "standard"), 180);
  });
});
