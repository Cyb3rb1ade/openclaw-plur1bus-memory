import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNeoStore } from "../lib/neo-arch.js";
import { makeTempDir } from "./helpers/temp-dir.js";

// 7.12.30: recordHookAsync wartet asynchron auf den Workspace-Lock.
describe("recordHookAsync", () => {
  it("merges hook state like recordHook and returns the merged record", async () => {
    const root = makeTempDir("neo-hook-async-");
    try {
      const store = createNeoStore(root, "ws");
      store.recordHook("before_prompt_build", { agentId: "a", processedDreams: ["d1"] });
      const merged = await store.recordHookAsync("before_prompt_build", { promptLength: 12 });
      assert.equal(merged.count, 2);
      assert.deepEqual(merged.processedDreams, ["d1"], "partial update keeps sibling keys");
      assert.equal(merged.promptLength, 12);
      assert.equal(store.readHooks().before_prompt_build.count, 2);
      const parallel = await Promise.all([1, 2, 3].map((n) => store.recordHookAsync("agent_end", { n })));
      assert.deepEqual(parallel.map((r) => r.count).sort(), [1, 2, 3]);
      assert.equal(store.readHooks().agent_end.count, 3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
