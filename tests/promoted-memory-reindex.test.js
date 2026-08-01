import { afterEach, describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = join(TEST_DIR, "..", "lib", "promoted-memory-reindex.js");
const tempDirs = [];

async function loadModule() {
  assert.ok(existsSync(MODULE_PATH), "lib/promoted-memory-reindex.js must exist");
  return import(`${pathToFileURL(MODULE_PATH).href}?test=${Date.now()}-${Math.random()}`);
}

function makeHome() {
  const dir = mkdtempSync(join(tmpdir(), "plur1bus-promoted-reindex-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe("promoted memory parsing and discovery", () => {
  it("parses promotion markers without score metadata", async () => {
    const { parsePromotionMarkers } = await loadModule();
    assert.deepStrictEqual(
      parsePromotionMarkers([
        "<!-- openclaw-memory-promotion:marker-1 -->",
        "- Durable fact for future recall [score=0.91 recalls=5 source=dream]",
        "<!-- openclaw-memory-promotion:marker-2 -->",
        "not a list item",
      ].join("\n")),
      [{ marker: "marker-1", text: "Durable fact for future recall" }],
    );
  });

  it("discovers one safe owner per workspace and prefers sys/MEMORY.md fallback", async () => {
    const { discoverPromotionTargets } = await loadModule();
    const home = makeHome();
    mkdirSync(join(home, "workspace", "sys"), { recursive: true });
    writeFileSync(join(home, "workspace", "sys", "MEMORY.md"), "# memory\n");
    const config = {
      agents: {
        defaults: { workspace: join(home, "workspace") },
        list: [
          { id: "main", workspace: join(home, "workspace") },
          { id: "main-helper", workspace: join(home, "workspace") },
        ],
      },
    };

    assert.deepStrictEqual(discoverPromotionTargets(config, home), [{
      agentId: "main",
      workspaceDir: join(home, "workspace"),
      memoryPath: join(home, "workspace", "sys", "MEMORY.md"),
      workspaceKey: "workspace",
    }]);
  });

  it("discovers current OpenClaw agents.entries object ownership", async () => {
    const { discoverPromotionTargets } = await loadModule();
    const home = makeHome();
    mkdirSync(join(home, "workspace", "sys"), { recursive: true });
    writeFileSync(join(home, "workspace", "sys", "MEMORY.md"), "# memory\n");
    const config = {
      agents: {
        defaults: { workspace: join(home, "workspace") },
        entries: {
          main: {},
          researcher: { workspace: join(home, "workspace") },
        },
      },
    };

    assert.deepStrictEqual(discoverPromotionTargets(config, home), [{
      agentId: "main",
      workspaceDir: join(home, "workspace"),
      memoryPath: join(home, "workspace", "sys", "MEMORY.md"),
      workspaceKey: "workspace",
    }]);
  });

  it("rejects traversal agent IDs and workspaces outside the OpenClaw home", async () => {
    const { discoverPromotionTargets } = await loadModule();
    const home = makeHome();
    mkdirSync(join(home, "workspace"), { recursive: true });
    assert.throws(
      () => discoverPromotionTargets({ agents: { list: [{ id: "../escape", workspace: join(home, "workspace") }] } }, home),
      /Invalid agent ID/,
    );
    assert.throws(
      () => discoverPromotionTargets({ agents: { list: [{ id: "main", workspace: "/tmp" }] } }, home),
      /Path traversal blocked/,
    );
  });
});

describe("promoted memory reindex execution", () => {
  it("creates deterministic UUIDs bound to agent and marker", async () => {
    const { stablePromotionId } = await loadModule();
    const first = stablePromotionId("main", "marker-1");
    assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.strictEqual(stablePromotionId("main", "marker-1"), first);
    assert.notStrictEqual(stablePromotionId("other", "marker-1"), first);
    assert.throws(() => stablePromotionId("../bad", "marker-1"), /Invalid agent ID/);
  });

  it("keeps dry-run free of provider and database side effects", async () => {
    const { applyPromotionReindex } = await loadModule();
    let dependencyCalled = false;
    const result = await applyPromotionReindex({ targets: [{ agentId: "main", promotions: [{ id: "x", text: "secret text" }] }] }, {
      apply: false,
      createEmbedder: async () => { dependencyCalled = true; },
      createMemoryDb: () => { dependencyCalled = true; },
    });
    assert.strictEqual(dependencyCalled, false);
    assert.deepStrictEqual(result.counts, { planned: 1, inserted: 0, skipped: 0, failed: 0 });
    assert.deepStrictEqual(result.agents, [{
      agentId: "main",
      counts: { planned: 1, inserted: 0, skipped: 0, failed: 0 },
    }]);
    assert.doesNotMatch(JSON.stringify(result), /secret text/);
  });

  it("propagates provider dimensions, skips stable duplicates, and redacts partial failures", async () => {
    const { applyPromotionReindex, stablePromotionId } = await loadModule();
    const seen = { vectorDim: null, closed: 0, stored: [] };
    const ids = ["one", "two", "three"].map((marker) => stablePromotionId("main", marker));
    const plan = {
      targets: [{
        agentId: "main",
        workspaceKey: "workspace",
        dbPath: "/safe/db/main",
        promotions: [
          { id: ids[0], markerHash: "h1", text: "first private fact" },
          { id: ids[1], markerHash: "h2", text: "second private fact" },
          { id: ids[2], markerHash: "h3", text: "contains secret-key" },
        ],
      }],
    };

    const result = await applyPromotionReindex(plan, {
      apply: true,
      now: () => 123456,
      createEmbedder: async () => ({
        dimensions: 3,
        embed: async () => [0.1, 0.2, 0.3],
      }),
      createMemoryDb: ({ vectorDim }) => {
        seen.vectorDim = vectorDim;
        return {
          getById: async (id) => id === ids[0] ? { id } : null,
          store: async (entry) => {
            if (entry.id === ids[2]) throw new Error("secret-key failed");
            seen.stored.push(entry);
          },
          shutdown: async () => { seen.closed += 1; },
        };
      },
    });

    assert.strictEqual(seen.vectorDim, 3);
    assert.strictEqual(seen.closed, 1);
    assert.strictEqual(seen.stored.length, 1);
    assert.strictEqual(seen.stored[0].origin, "dreaming-promotion");
    assert.strictEqual(seen.stored[0].vector.length, 3);
    assert.deepStrictEqual(result.counts, { planned: 3, inserted: 1, skipped: 1, failed: 1 });
    assert.strictEqual(result.ok, false);
    assert.doesNotMatch(JSON.stringify(result), /private fact|secret-key/);
  });
});
