import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DISPLAY_SOURCES,
  sanitizeMemoryContextAttribute,
  sanitizeMemoryTextForPrompt,
} from "../lib/memory-context-sanitize.js";

describe("memory-context-sanitize", () => {
  it("keeps allowed display sources", () => {
    assert.ok(DISPLAY_SOURCES.has("group"));
    assert.ok(DISPLAY_SOURCES.has("cron"));
    assert.ok(DISPLAY_SOURCES.has("internal"));
  });

  it("sanitizes attribute to safe identifier", () => {
    assert.strictEqual(sanitizeMemoryContextAttribute("hello world", "fallback"), "hello_world");
    assert.strictEqual(sanitizeMemoryContextAttribute("", "fallback"), "fallback");
    assert.strictEqual(sanitizeMemoryContextAttribute("a<b>", "fallback"), "a_b_");
  });

  it("truncates attribute to 160 chars", () => {
    const long = "x".repeat(200);
    assert.strictEqual(sanitizeMemoryContextAttribute(long, "fallback").length, 160);
  });

  it("sanitizes memory text for prompt", () => {
    const text = "Hello <script>alert(1)</script> world";
    const out = sanitizeMemoryTextForPrompt(text, 400);
    assert.ok(!out.includes("<script>"));
    assert.ok(out.includes("Hello"));
    assert.ok(out.includes("world"));
  });

  it("truncates memory text to maxChars", () => {
    const text = "x".repeat(1000);
    assert.strictEqual(sanitizeMemoryTextForPrompt(text, 100).length, 100);
  });
});
