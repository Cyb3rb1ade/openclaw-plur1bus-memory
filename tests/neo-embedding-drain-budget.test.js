/**
 * tests/neo-embedding-drain-budget.test.js
 *
 * Regression 2026-08-20: drainEmbeddingQueueFile war ausschliesslich
 * mengenbegrenzt (maxItems, default 250). Der auto-capture-Hook ruft den Drain
 * innerhalb seines eigenen 60s-Zeitbudgets auf. Bei vollem Rueckstau
 * verbrauchte der Drain das Budget komplett und die eigentliche Erfassung wurde
 * anschliessend jedes Mal abgebrochen — im Log sichtbar als
 * "found 276 texts to capture" gefolgt vom Timeout ~30ms spaeter.
 *
 * Die Schleife respektiert jetzt options.signal und options.deadlineMs und
 * meldet einen vorzeitigen Stopp ueber stoppedEarly.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNeoStore } from "../lib/neo-arch.js";

function makeWorkspace(itemCount) {
  const root = mkdtempSync(join(tmpdir(), "neo-drain-budget-"));
  const store = createNeoStore(root, "testws");
  const queuePath = store.paths?.embeddings
    || join(root, "workspaces", "testws", "embedding-queue.jsonl");
  mkdirSync(join(queuePath, ".."), { recursive: true });

  const lines = [];
  for (let i = 0; i < itemCount; i++) {
    lines.push(JSON.stringify({
      id: `embq_test_${i}`,
      targetId: `mem_test_${i}`,
      targetType: "memory",
      workspaceKey: "testws",
      agentId: "testagent",
      impact: "low",
      status: "pending",
      queuedAt: new Date().toISOString(),
    }));
  }
  writeFileSync(queuePath, lines.join("\n") + "\n");
  return { root, store };
}

describe("drainEmbeddingQueue — Zeitbudget des Aufrufers", () => {
  it("bricht bei bereits abgebrochenem Signal ab, ohne ein Item zu verarbeiten", async () => {
    const { root, store } = makeWorkspace(50);
    try {
      const controller = new AbortController();
      controller.abort();

      const result = await store.drainEmbeddingQueue({
        impact: "low",
        maxItems: 50,
        signal: controller.signal,
        embedder: () => {
          assert.fail("embedder darf bei abgebrochenem Signal nicht laufen");
        },
      });

      assert.equal(result.processed, 0, "kein Item darf verarbeitet werden");
      assert.equal(result.stoppedEarly, true, "stoppedEarly muss gesetzt sein");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stoppt an der Deadline, statt maxItems auszuschoepfen", async () => {
    const { root, store } = makeWorkspace(50);
    try {
      // Deadline liegt in der Vergangenheit, sobald die Schleife startet:
      // der Guard greift vor dem ersten Item.
      const result = await store.drainEmbeddingQueue({
        impact: "low",
        maxItems: 50,
        deadlineMs: 1,
        embedder: async (text) => {
          await new Promise((r) => setTimeout(r, 50));
          return [0, 0, 0];
        },
      });

      assert.ok(result.processed < 50, `processed=${result.processed} muss unter maxItems liegen`);
      assert.equal(result.stoppedEarly, true, "stoppedEarly muss gesetzt sein");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("laeuft ohne signal/deadline unveraendert weiter (kein Verhaltensbruch)", async () => {
    const { root, store } = makeWorkspace(5);
    try {
      const result = await store.drainEmbeddingQueue({ impact: "low", maxItems: 5 });
      assert.equal(result.stoppedEarly, false, "ohne Budgetgrenze kein vorzeitiger Stopp");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
