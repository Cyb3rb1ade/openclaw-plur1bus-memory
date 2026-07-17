import { describe, it } from "node:test";
import assert from "node:assert";

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

describe("LLM result cache status", () => {
  it("renders per-agent hit, token, and active persistence metrics", () => {
    const llmResultCache = {
      requests: 10,
      hits: 4,
      hitRate: 0.4,
      memoryHits: 3,
      persistHits: 1,
      avoidedInputTokens: 1200,
      avoidedOutputTokens: 300,
      persistConfigured: true,
      persistActive: true,
    };

    const rendered = renderStatus(
      collectStatusData({ openclawConfig, llmResultCache }),
      { lang: "en" }
    );

    assert.match(rendered, /LLM Result Cache/);
    assert.match(rendered, /Hit rate: 40\.0% \(4\/10\)/);
    assert.match(rendered, /Hits: memory=3, persistent=1/);
    assert.match(rendered, /Avoided tokens: input=1,200, output=300/);
    assert.match(rendered, /Persistence: active/);
    assert.doesNotMatch(rendered, /\$|dollars?/i);
  });

  it("omits the section when cache metrics are unavailable", () => {
    const rendered = renderStatus(collectStatusData({ openclawConfig }), { lang: "en" });
    assert.doesNotMatch(rendered, /LLM Result Cache/);
  });

  it("distinguishes inactive configured persistence from persistence off", () => {
    const configured = renderStatus(collectStatusData({
      openclawConfig,
      llmResultCache: {
        requests: 0,
        hits: 0,
        hitRate: 0,
        memoryHits: 0,
        persistHits: 0,
        avoidedInputTokens: 0,
        avoidedOutputTokens: 0,
        persistConfigured: true,
        persistActive: false,
      },
    }));
    const off = renderStatus(collectStatusData({
      openclawConfig,
      llmResultCache: {
        requests: 0,
        hits: 0,
        hitRate: 0,
        memoryHits: 0,
        persistHits: 0,
        avoidedInputTokens: 0,
        avoidedOutputTokens: 0,
        persistConfigured: false,
        persistActive: false,
      },
    }));

    assert.match(configured, /Persistence: configured but inactive/);
    assert.match(off, /Persistence: off/);
  });
});
