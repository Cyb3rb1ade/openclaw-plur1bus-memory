import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

import { collectStatusData } from "../lib/telegram-commands/status-data.js";
import { renderStatus } from "../lib/telegram-commands/status.js";

const openclawConfig = {
  plugins: {
    entries: {
      "memory-lancedb-namespaced": {
        config: { obsidianBridge: { enabled: true } },
      },
    },
  },
};

describe("/state command", () => {
  it("uses commandCtx.agentId for distinctive per-agent cache metrics", () => {
    const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
    const handlerStart = source.indexOf("const runStatusCommand = async (commandCtx) => {");
    const handlerEnd = source.indexOf("const parseFeatureArg", handlerStart);
    const handlerSource = source.slice(handlerStart, handlerEnd);
    assert.ok(handlerStart >= 0 && handlerEnd > handlerStart, "status handler source must be found");
    assert.match(handlerSource, /const agentId = commandCtx\?\.agentId \|\| "default";/);
    assert.match(handlerSource, /llmResultCache: llmResultCache\.getMetrics\(agentId\)/);
    assert.doesNotMatch(handlerSource, /getMetrics\(ctx/);

    const requestedScopes = [];
    const metrics = {
      getMetrics(scopeId) {
        requestedScopes.push(scopeId);
        return {
          requests: 7,
          hits: 3,
          hitRate: 3 / 7,
          memoryHits: 2,
          persistHits: 1,
          avoidedInputTokens: 1234,
          avoidedOutputTokens: 56,
          persistConfigured: true,
          persistActive: true,
        };
      },
    };
    const statusText = renderStatus(collectStatusData({
      openclawConfig,
      llmResultCache: metrics.getMetrics("agent-ctx-test"),
    }), { lang: "en" });

    assert.deepStrictEqual(requestedScopes, ["agent-ctx-test"]);
    assert.match(statusText, /LLM Result Cache/);
    assert.match(statusText, /Hit rate: 42\.9% \(3\/7\)/);
    assert.match(statusText, /Hits: memory=2, persistent=1/);
    assert.match(statusText, /Avoided tokens: input=1,234, output=56/);
  });
});
