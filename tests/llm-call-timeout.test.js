/**
 * Regression: the shared callLlm helper must enforce its own timeout. Many
 * callers use it directly, so a hung OpenAI-compatible request must not pin the
 * surrounding job until an outer runtime timeout fires.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { callLlm } from "../lib/llm-call.js";

describe("callLlm timeout", () => {
  it("rejects at the configured timeoutMs when the provider never resolves", async () => {
    class HangingOpenAI {
      constructor() {
        this.chat = {
          completions: {
            create: async () => new Promise(() => {}),
          },
        };
      }
    }

    const start = Date.now();
    await assert.rejects(
      () => callLlm(
        [{ role: "user", content: "hello" }],
        { apiKey: "test-key", model: "test-model", timeoutMs: 30 },
        { OpenAI: HangingOpenAI },
      ),
      /timed out/i,
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 1000, `callLlm should time out quickly, took ${elapsed}ms`);
  });
});
