/**
 * test/proactive-nudges-embedding.test.js — Tests für Embedding-basierte
 * Pattern-Erkennung, Cluster-Persistenz und Cooldown.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cosineSimilarity,
  clusterTurnsByEmbedding,
  computeCentroid,
} from "../lib/pattern-detector-embedding.js";
import { generateProactiveNudge, shouldShowNudge } from "../lib/proactive-nudge.js";
import { runProactiveCheck } from "../lib/jobs/proactive-check.js";

describe("cosineSimilarity", () => {
  it("identische Vektoren = 1.0", () => {
    const a = [1, 0, 0];
    const b = [1, 0, 0];
    assert.strictEqual(cosineSimilarity(a, b), 1);
  });

  it("orthogonale Vektoren = 0.0", () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    assert.strictEqual(cosineSimilarity(a, b), 0);
  });

  it("entgegengesetzte Vektoren = -1.0", () => {
    const a = [1, 0, 0];
    const b = [-1, 0, 0];
    assert.strictEqual(cosineSimilarity(a, b), -1);
  });

  it("ähnliche Vektoren > 0.8", () => {
    const a = [1, 0.1, 0.1];
    const b = [1, 0.15, 0.05];
    assert.ok(cosineSimilarity(a, b) > 0.8);
  });
});

describe("computeCentroid", () => {
  it("berechnet Mittelwert über mehrere Vektoren", () => {
    const vectors = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    const c = computeCentroid(vectors);
    assert.deepStrictEqual(c, [1 / 3, 1 / 3, 1 / 3]);
  });

  it("leeres Array → leerer Vektor", () => {
    assert.deepStrictEqual(computeCentroid([]), []);
  });
});

describe("clusterTurnsByEmbedding", () => {
  it("gruppiert ähnliche Turns in Cluster", async () => {
    const turns = [
      { id: "t1", text: "Ich arbeite an der API" },
      { id: "t2", text: "Ich arbeite an der API heute" },
      { id: "t3", text: "Ich arbeite an der API morgen" },
      { id: "t4", text: "Das Wetter ist schön" },
      { id: "t5", text: "Das Wetter ist schön heute" },
    ];

    // Mock embedFn: einfache Bag-of-Words-Vektoren
    const vocab = ["arbeite", "an", "der", "api", "heute", "morgen", "wetter", "ist", "schön"];
    const mockEmbed = (text) => {
      const words = text.toLowerCase().split(/\s+/);
      return vocab.map((w) => (words.includes(w) ? 1 : 0));
    };

    const clusters = await clusterTurnsByEmbedding(turns, mockEmbed, { threshold: 0.5 });
    assert.ok(clusters.length >= 2, `Sollte mindestens 2 Cluster haben, hat ${clusters.length}`);

    // API-Cluster sollte t1, t2, t3 enthalten
    const apiCluster = clusters.find((c) => c.turnIds.includes("t1"));
    assert.ok(apiCluster, "Sollte API-Cluster finden");
    assert.ok(apiCluster.turnIds.includes("t2"), "API-Cluster sollte t2 enthalten");
    assert.ok(apiCluster.turnIds.includes("t3"), "API-Cluster sollte t3 enthalten");

    // Wetter-Cluster sollte t4, t5 enthalten
    const weatherCluster = clusters.find((c) => c.turnIds.includes("t4"));
    assert.ok(weatherCluster, "Sollte Wetter-Cluster finden");
    assert.ok(weatherCluster.turnIds.includes("t5"), "Wetter-Cluster sollte t5 enthalten");
  });

  it("filtered leere Turns aus", async () => {
    const turns = [
      { id: "t1", text: "" },
      { id: "t2", text: "   " },
      { id: "t3", text: "Hallo" },
    ];
    const mockEmbed = (text) => [text.length];
    const clusters = await clusterTurnsByEmbedding(turns, mockEmbed, { threshold: 0.5, minClusterSize: 1 });
    assert.strictEqual(clusters.length, 1);
    assert.deepStrictEqual(clusters[0].turnIds, ["t3"]);
  });

  it("minClusterSize filtert kleine Cluster", async () => {
    const turns = [
      { id: "t1", text: "A" },
      { id: "t2", text: "B" },
      { id: "t3", text: "A" },
    ];
    // 2D-Vektoren mit klarer Trennung: A=[1,0], B=[0,1]
    const mockEmbed = (text) => {
      return text === "A" ? [1, 0] : [0, 1];
    };
    const clusters = await clusterTurnsByEmbedding(turns, mockEmbed, { threshold: 0.5, minClusterSize: 2 });
    assert.strictEqual(clusters.length, 1);
    assert.deepStrictEqual(clusters[0].turnIds, ["t1", "t3"]);
  });
});

describe("generateProactiveNudge mit Clustern", () => {
  it("erzeugt Nudge aus Cluster-Representative", () => {
    const clusters = [
      {
        keyword: "API-Entwicklung",
        representative: "API-Entwicklung",
        turnIds: ["t1", "t2", "t3"],
        score: 0.85,
        recencyHours: 12,
        occurrences: 3,
      },
    ];
    const nudge = generateProactiveNudge({ now: Date.now() }, clusters, { threshold: 0.6 });
    assert.ok(nudge, "Sollte Nudge erzeugen");
    assert.match(nudge.text, /API-Entwicklung/);
    assert.ok(nudge.score >= 0.6);
  });

  it("gibt null wenn kein Cluster über Threshold", () => {
    const clusters = [{ representative: "X", turnIds: ["t1"], score: 0.3, recencyHours: 100 }];
    const nudge = generateProactiveNudge({ now: Date.now() }, clusters, { threshold: 0.6 });
    assert.strictEqual(nudge, null);
  });
});

describe("shouldShowNudge Cooldown", () => {
  it("erlaubt ersten Nudge", () => {
    assert.strictEqual(shouldShowNudge({ keyword: "api" }, null, Date.now(), { jitter: false, quietHours: false }), true);
  });

  it("blockiert Nudge innerhalb von 24h", () => {
    const now = Date.now();
    assert.strictEqual(shouldShowNudge({ keyword: "api" }, now - 12 * 3600_000, now), false);
  });

  it("erlaubt Nudge nach 24h", () => {
    const now = Date.now();
    assert.strictEqual(shouldShowNudge({ keyword: "api" }, now - 25 * 3600_000, now, { jitter: false, quietHours: false }), true);
  });
});

describe("runProactiveCheck End-to-End", () => {
  it("generiert Nudges aus Turns und persistiert Cluster", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-proactive-"));

    try {
      const now = Date.now();
      const turns = [
        // API-Turns an unterschiedlichen Tagen/Stunden für Diversität
        { id: "t1", content: "Ich arbeite an der API", createdAt: now - 26 * 3600_000 },
        { id: "t2", content: "Ich arbeite an der API heute", createdAt: now - 50 * 3600_000 },
        { id: "t3", content: "Ich arbeite an der API morgen", createdAt: now - 74 * 3600_000 },
        { id: "t4", content: "Das Wetter ist schön", createdAt: now - 26 * 3600_000 },
        { id: "t5", content: "Das Wetter ist schön heute", createdAt: now - 50 * 3600_000 },
        { id: "t6", content: "Das Wetter ist schön morgen", createdAt: now - 74 * 3600_000 },
      ];

      // Klar getrennte 2D-Embeddings: API = [1,0], Wetter = [0,1]
      const mockEmbed = (text) => {
        const t = text.toLowerCase();
        if (t.includes("api")) return [1, 0.1];
        if (t.includes("wetter")) return [0.1, 1];
        return [0, 0];
      };

      const mockStore = {
        readTurns: (n) => turns.slice(-n),
      };

      const result = await runProactiveCheck(mockStore, "test-agent", {
        workspaceDir: dir,
        workspaceKey: "test-ws",
        now,
        embedFn: mockEmbed,
        threshold: 0.1,
      });

      assert.strictEqual(result.ok, true);
      assert.ok(result.patternsFound >= 2, `Sollte mindestens 2 Patterns finden, hat ${result.patternsFound}`);

      // Cluster-Persistenz prüfen
      const patternsPath = join(dir, ".adaptive-learning", "patterns.jsonl");
      assert.ok(existsSync(patternsPath), "Sollte patterns.jsonl persistieren");

      const lines = readFileSync(patternsPath, "utf8").trim().split("\n").filter(Boolean);
      assert.ok(lines.length >= 2, `Sollte mindestens 2 Cluster persistieren, hat ${lines.length}`);

      const firstCluster = JSON.parse(lines[0]);
      assert.ok(firstCluster.clusterId, "Sollte clusterId haben");
      assert.ok(Array.isArray(firstCluster.turnIds), "Sollte turnIds haben");
      assert.ok(firstCluster.representative, "Sollte representative haben");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("respektiert Cooldown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-proactive-cooldown-"));

    try {
      const now = Date.now();
      // 3 API-Turns an unterschiedlichen Tagen für Diversität > 0
      const turns = [
        { id: "t1", content: "Ich arbeite an der API", createdAt: now - 26 * 3600_000 },
        { id: "t2", content: "Ich arbeite an der API heute", createdAt: now - 50 * 3600_000 },
        { id: "t3", content: "Ich arbeite an der API morgen", createdAt: now - 74 * 3600_000 },
      ];

      const mockEmbed = (text) => {
        const t = text.toLowerCase();
        if (t.includes("api")) return [1, 0.1];
        return [0, 0];
      };

      const mockStore = { readTurns: (n) => turns.slice(-n) };

      // Erster Run → generiert Nudge
      const result1 = await runProactiveCheck(mockStore, "test-agent", {
        workspaceDir: dir,
        workspaceKey: "test-ws",
        now,
        embedFn: mockEmbed,
        threshold: 0.1,
      });
      assert.ok(result1.nudgesGenerated > 0, `Sollte beim ersten Run Nudges generieren, hat ${result1.nudgesGenerated}`);

      // Zweiter Run innerhalb von 24h → keine neuen Nudges
      const result2 = await runProactiveCheck(mockStore, "test-agent", {
        workspaceDir: dir,
        workspaceKey: "test-ws",
        now,
        embedFn: mockEmbed,
        threshold: 0.1,
      });
      assert.strictEqual(result2.nudgesGenerated, 0, "Sollte innerhalb von 24h keine Nudges generieren");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("begrenzt patterns.jsonl und cooldown state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-proactive-bounds-"));

    try {
      const now = Date.now();
      const adaptiveDir = join(dir, ".adaptive-learning");
      mkdirSync(adaptiveDir, { recursive: true });
      writeFileSync(
        join(adaptiveDir, "patterns.jsonl"),
        Array.from({ length: 5 }, (_, index) => JSON.stringify({ clusterId: `old-${index}` })).join("\n") + "\n",
        "utf8",
      );
      writeFileSync(
        join(adaptiveDir, "proactive-nudge-cooldowns.json"),
        JSON.stringify({
          old1: now - 1,
          old2: now - 2,
          old3: now - 3,
          old4: now - 4,
          old5: now - 5,
        }),
        "utf8",
      );

      const turns = [
        { id: "t1", content: "Ich arbeite an der API", createdAt: now - 26 * 3600_000 },
        { id: "t2", content: "Ich arbeite an der API heute", createdAt: now - 50 * 3600_000 },
        { id: "t3", content: "Ich arbeite an der API morgen", createdAt: now - 74 * 3600_000 },
      ];
      const mockStore = { readTurns: (n) => turns.slice(-n) };

      await runProactiveCheck(mockStore, "test-agent", {
        workspaceDir: dir,
        workspaceKey: "test-ws",
        now,
        embedFn: (text) => text.toLowerCase().includes("api") ? [1, 0.1] : [0, 0],
        threshold: 0.1,
        maxPatternLogEntries: 3,
        maxCooldownEntries: 3,
      });

      const patternLines = readFileSync(join(adaptiveDir, "patterns.jsonl"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean);
      assert.ok(patternLines.length <= 3, `patterns.jsonl should be capped, got ${patternLines.length}`);

      const cooldowns = JSON.parse(readFileSync(join(adaptiveDir, "proactive-nudge-cooldowns.json"), "utf8"));
      assert.ok(Object.keys(cooldowns).length <= 3, `cooldowns should be capped, got ${Object.keys(cooldowns).length}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
