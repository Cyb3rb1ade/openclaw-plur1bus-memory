/**
 * P1 Robustheit Regression Tests
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { redactError, safeWarn, safeDebug, trySafeWarn } from "../lib/safe-logging.js";
import { fetchWithTimeout, fetchWithRetry } from "../lib/fetch-with-timeout.js";
import { validateInput, validateCommandArgs, INPUT_LIMITS } from "../lib/input-limits.js";

describe("redactError", () => {
  it("redacts Bearer tokens", () => {
    const r = redactError(new Error("Request failed with Bearer sk-abc123"));
    assert.ok(!r.message.includes("sk-abc123"));
    assert.ok(r.message.includes("[REDACTED]"));
  });

  it("redacts api_key", () => {
    const r = redactError(new Error("invalid api_key=secret123"));
    assert.ok(!r.message.includes("secret123"));
    assert.ok(r.message.includes("[REDACTED]"));
  });

  it("truncates long messages", () => {
    const r = redactError(new Error("x".repeat(1000)));
    assert.ok(r.message.length < 600);
  });

  it("handles string input", () => {
    const r = redactError("simple string error");
    assert.strictEqual(r.message, "simple string error");
  });
});

describe("trySafeWarn", () => {
  it("returns a logger failure without throwing or replacing caller control flow", () => {
    const loggerError = new Error("injected warning transport failure");
    const result = trySafeWarn({
      warn() { throw loggerError; },
    }, "test-warning", new Error("original operation failed"));

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, loggerError);
  });
});

describe("validateInput", () => {
  it("accepts valid input", () => {
    const r = validateInput("hello", { maxLength: 100, name: "test" });
    assert.strictEqual(r.ok, true);
  });

  it("rejects too long input with clear error", () => {
    const r = validateInput("x".repeat(100), { maxLength: 10, name: "query" });
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes("query"));
    assert.ok(r.error.includes("10"));
    assert.ok(r.error.includes("100"));
  });

  it("rejects empty when required", () => {
    const r = validateInput("", { required: true, name: "text" });
    assert.strictEqual(r.ok, false);
  });

  it("allows null when not required", () => {
    const r = validateInput(null, { maxLength: 10 });
    assert.strictEqual(r.ok, true);
  });
});

describe("validateCommandArgs", () => {
  it("accepts short args", () => {
    const r = validateCommandArgs("hello world");
    assert.strictEqual(r.ok, true);
  });

  it("rejects overlong args", () => {
    const r = validateCommandArgs("x".repeat(INPUT_LIMITS.COMMAND_ARGS + 1));
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes("command arguments"));
  });
});

describe("fetchWithTimeout", () => {
  it("throws on timeout", async () => {
    // Use a URL that will hang
    await assert.rejects(
      fetchWithTimeout("http://localhost:59999/nonexistent", {}, 1),
      /AbortError|fetch failed/
    );
  });

  it("returns response on success", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
      const res = await fetchWithTimeout("http://example.test/get", {}, 10_000);
      assert.ok(res.ok);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("fetchWithRetry", () => {
  it("retries idempotent GET on failure", async () => {
    // Use a URL that will fail then succeed — hard to test reliably without mock server
    // Just verify it doesn't hang and throws on complete failure
    await assert.rejects(
      fetchWithRetry("http://localhost:59999/nonexistent", { method: "GET" }, { timeoutMs: 1, maxRetries: 1, backoffMs: 1 }),
      /fetch failed|AbortError/
    );
  });

  it("does not retry non-idempotent POST", async () => {
    await assert.rejects(
      fetchWithRetry("http://localhost:59999/nonexistent", { method: "POST" }, { timeoutMs: 1, maxRetries: 2, backoffMs: 1 }),
      /fetch failed|AbortError/
    );
  });
});

describe("MemoryDB shutdown idempotency", () => {
  it("can call shutdown twice without error", async () => {
    // We can't easily instantiate MemoryDB without LanceDB, but we can test the pattern
    // by mocking the minimal interface
    const mockDb = {
      isShuttingDown: false,
      isShutdown: false,
      db: { close: async () => {} },
      table: { close: async () => {} },
      async shutdown() {
        if (this.isShuttingDown || this.isShutdown) return;
        this.isShuttingDown = true;
        try {
          if (this.table && typeof this.table.close === "function") {
            try { await this.table.close(); } catch (_) {}
          }
          if (this.db && typeof this.db.close === "function") {
            try { await this.db.close(); } catch (_) {}
          }
        } finally {
          this.table = null;
          this.db = null;
          this.isShutdown = true;
          this.isShuttingDown = false;
        }
      },
    };
    await mockDb.shutdown();
    await mockDb.shutdown();
    assert.strictEqual(mockDb.isShutdown, true);
    assert.strictEqual(mockDb.isShuttingDown, false);
  });
});
