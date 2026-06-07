/**
 * tests/smoke-i18n.test.js — i18n core tests.
 *
 * Covers: resolveLocale, detectLanguage, readSoulTone, pickTone,
 * t() fallback chain, missing vars, missing keys, format escaping.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  resolveLocale,
  detectLanguage,
  readSoulTone,
  readSoulToneCached,
  pickTone,
  t,
} from "../lib/i18n.js";
import { dictionary } from "../lib/i18n-dictionary.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("resolveLocale", () => {
  it("uses config when provided", () => {
    assert.strictEqual(resolveLocale({ config: "de" }), "de");
  });

  it("falls back to ctx.lang", () => {
    assert.strictEqual(resolveLocale({ ctx: { lang: "de" } }), "de");
  });

  it("detects language from messages", () => {
    const messages = [{ role: "user", content: "Hallo, wie geht es dir?" }];
    assert.strictEqual(resolveLocale({ messages }), "de");
  });

  it("falls back to default 'en'", () => {
    assert.strictEqual(resolveLocale({}), "en");
  });

  it("config beats ctx", () => {
    assert.strictEqual(resolveLocale({ config: "en", ctx: { lang: "de" } }), "en");
  });
});

describe("detectLanguage", () => {
  it("returns 'en' for empty messages", () => {
    assert.strictEqual(detectLanguage([]), "en");
  });

  it("detects German from common words", () => {
    const messages = [
      { role: "user", content: "Hallo, ich habe eine Frage." },
    ];
    assert.strictEqual(detectLanguage(messages), "de");
  });

  it("returns 'en' for English text", () => {
    const messages = [
      { role: "user", content: "Hello, how are you today?" },
    ];
    assert.strictEqual(detectLanguage(messages), "en");
  });

  it("ignores non-user messages", () => {
    const messages = [
      { role: "assistant", content: "Hallo, wie geht es dir?" },
    ];
    assert.strictEqual(detectLanguage(messages), "en");
  });

  it("looks at last 3 user messages", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "user", content: "World" },
      { role: "user", content: "das ist gut" },
    ];
    assert.strictEqual(detectLanguage(messages), "de");
  });
});

describe("readSoulTone", () => {
  const tmpDir = join(tmpdir(), `i18n-test-${Date.now()}`);

  it("returns null when no SOUL/IDENTITY file exists", () => {
    assert.strictEqual(readSoulTone("/nonexistent/path"), null);
  });

  it("reads Tone heading from SOUL.MD", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "SOUL.MD"), "# SOUL\n\nTone: casual and friendly\n", "utf8");
    assert.strictEqual(readSoulTone(tmpDir), "casual and friendly");
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads first non-comment line as fallback", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "IDENTITY.md"), "Professional and formal\n# Heading\n", "utf8");
    assert.strictEqual(readSoulTone(tmpDir), "Professional and formal");
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null for empty workspaceDir", () => {
    assert.strictEqual(readSoulTone(null), null);
    assert.strictEqual(readSoulTone(""), null);
  });
});

describe("readSoulToneCached", () => {
  const tmpDir = join(tmpdir(), `i18n-cache-test-${Date.now()}`);

  it("caches result and respects TTL", () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "SOUL.MD"), "Tone: casual", "utf8");

    const first = readSoulToneCached(tmpDir, { ttlMs: 1000 });
    assert.strictEqual(first, "casual");

    // Change file content — should still get cached value
    writeFileSync(join(tmpDir, "SOUL.MD"), "Tone: formal", "utf8");
    const second = readSoulToneCached(tmpDir, { ttlMs: 1000 });
    assert.strictEqual(second, "casual");

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("pickTone", () => {
  it("returns 'default' for null/empty", () => {
    assert.strictEqual(pickTone(null), "default");
    assert.strictEqual(pickTone(""), "default");
  });

  it("detects casual", () => {
    assert.strictEqual(pickTone("casual and friendly"), "casual");
    assert.strictEqual(pickTone("WARM and relaxed"), "casual");
    assert.strictEqual(pickTone("locker"), "casual");
  });

  it("detects formal", () => {
    assert.strictEqual(pickTone("formal business tone"), "formal");
    assert.strictEqual(pickTone("PROFESSIONAL"), "formal");
    assert.strictEqual(pickTone("förmlich"), "formal");
  });

  it("returns 'default' for unknown hints", () => {
    assert.strictEqual(pickTone("sarcastic"), "default");
  });
});

describe("t() fallback chain", () => {
  it("returns exact lang+tone match", () => {
    const text = t("skill.no_proposals", { lang: "de", tone: "casual" });
    assert.ok(text.includes("Keine offenen"), `got: ${text}`);
  });

  it("falls back to lang.default when tone missing", () => {
    const text = t("skill.no_proposals", { lang: "de", tone: "formal" });
    // de has no formal, should fall to de.default
    assert.ok(text.includes("Keine offenen"), `got: ${text}`);
  });

  it("falls back to en.default when lang missing", () => {
    const text = t("skill.no_proposals", { lang: "fr", tone: "casual" });
    assert.ok(text.includes("No open skill proposals"), `got: ${text}`);
  });

  it("returns key for missing dictionary entry", () => {
    const text = t("nonexistent.key.12345", { lang: "en", tone: "default" });
    assert.strictEqual(text, "nonexistent.key.12345");
  });

  it("interpolates variables", () => {
    const text = t("skill.approve_success", {
      lang: "en",
      tone: "default",
      vars: { title: "Test Skill", name: "test-skill" },
    });
    assert.ok(text.includes("Test Skill"), `got: ${text}`);
    assert.ok(text.includes("test-skill"), `got: ${text}`);
  });

  it("leaves missing vars as empty string", () => {
    const text = t("skill.approve_success", {
      lang: "en",
      tone: "default",
      vars: {},
    });
    assert.ok(text.includes('""'), `got: ${text}`);
  });

  it("escapes Telegram Markdown chars", () => {
    const text = t("skill.approve_success", {
      lang: "en",
      tone: "default",
      vars: { title: "Test_Skill*", name: "test-skill" },
      format: "telegramMarkdown",
    });
    assert.ok(text.includes("Test\\_Skill\\*"), `got: ${text}`);
  });

  it("escapes HTML chars", () => {
    const text = t("skill.approve_success", {
      lang: "en",
      tone: "default",
      vars: { title: "Test <b>Skill</b>", name: "test-skill" },
      format: "html",
    });
    assert.ok(text.includes("Test &lt;b&gt;Skill&lt;/b&gt;"), `got: ${text}`);
  });
});

describe("dictionary coverage", () => {
  it("every key has en.default", () => {
    const missing = [];
    for (const key of Object.keys(dictionary)) {
      if (!dictionary[key]?.en?.default) {
        missing.push(key);
      }
    }
    assert.strictEqual(missing.length, 0, `Missing en.default for keys: ${missing.join(", ")}`);
  });
});
