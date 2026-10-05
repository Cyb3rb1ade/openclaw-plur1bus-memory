import { describe, it } from "node:test";
import assert from "node:assert";
import net from "node:net";
import { redactUrl, redactUrlsInText, shortHash } from "../lib/log-redact.js";
import { fetchWithTimeout, fetchWithRetry } from "../lib/fetch-with-timeout.js";
import { runReminderDispatch } from "../lib/jobs/reminder-dispatch.js";
import { makeTempDir } from "./helpers/temp-dir.js";
import { rmSync } from "node:fs";

const MARKER = "SECRETMARKER9f3a71";

describe("redactUrl", () => {
  it("drops userinfo, path and query", () => {
    const out = redactUrl(`https://user:${MARKER}@api.example.com:8443/v1/embeddings?key=${MARKER}`);
    assert.ok(out.startsWith("https://api.example.com:8443 pathHash="), out);
    assert.ok(!out.includes(MARKER) && !out.includes("user") && !out.includes("v1"));
  });
  it("hides Discord webhook path and query tokens", () => {
    const out = redactUrl(`https://discord.com/api/webhooks/123456789/${MARKER}?wait=true&token=${MARKER}`);
    assert.match(out, /^https:\/\/discord\.com pathHash=[0-9a-f]{12}$/);
    assert.ok(!out.includes(MARKER) && !out.includes("123456789"));
  });
  it("pathHash is stable and distinguishes paths; omitted for bare origin", () => {
    assert.strictEqual(redactUrl("https://h.example/a?x=1"), redactUrl("https://h.example/a?x=1"));
    assert.notStrictEqual(redactUrl("https://h.example/a"), redactUrl("https://h.example/b"));
    assert.strictEqual(redactUrl("https://h.example/"), "https://h.example");
    assert.ok(redactUrl("https://h.example/a").endsWith(shortHash("/a")));
  });
  it("invalid URL becomes url=<invalid> with a hash", () => {
    const out = redactUrl(`not a url ${MARKER}`);
    assert.match(out, /^url=<invalid> hash=[0-9a-f]{12}$/);
    assert.ok(!out.includes(MARKER));
    assert.match(redactUrl(undefined), /^url=<invalid> hash=/);
  });
  it("redactUrlsInText scrubs embedded URLs", () => {
    const out = redactUrlsInText(`Failed to parse URL from https://u:p@h.example/x/${MARKER}?k=${MARKER}, retrying`);
    assert.ok(!out.includes(MARKER) && out.includes("h.example") && out.includes("retrying"), out);
  });
});

async function closedPort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

function assertClean(text, label) {
  assert.ok(!String(text).includes(MARKER), `${label} leaked marker: ${text}`);
}

describe("fetchWithTimeout hides the target URL", { timeout: 30_000 }, () => {
  it("unreachable port", async () => {
    const port = await closedPort();
    const url = `http://user:${MARKER}@127.0.0.1:${port}/hooks/${MARKER}?token=${MARKER}`;
    const err = await fetchWithTimeout(url, {}, 2000).then(() => null, (e) => e);
    assert.ok(err);
    assertClean(err.message, "message");
    assertClean(err.stack, "stack");
    assert.strictEqual(err.cause, undefined);
    assert.ok(err.message.includes("127.0.0.1"));
  });
  it("unparseable URL (runtime echoes it in the message)", async () => {
    const err = await fetchWithTimeout(`not a url ${MARKER}?k=${MARKER}`, {}, 2000).then(() => null, (e) => e);
    assert.ok(err);
    assertClean(err.message, "message");
    assertClean(err.stack, "stack");
  });
  it("stubbed fetch whose error and cause embed the URL", async () => {
    const orig = globalThis.fetch;
    const url = `https://hooks.example.com/services/T0/B0/${MARKER}?x=${MARKER}`;
    globalThis.fetch = async () => {
      const e = new TypeError(`fetch failed ${url}`);
      e.cause = Object.assign(new Error(`connect ECONNREFUSED ${url}`), { code: "ECONNREFUSED" });
      throw e;
    };
    try {
      const err = await fetchWithTimeout(url, {}, 1000).then(() => null, (e) => e);
      assertClean(err.message, "message");
      assert.strictEqual(err.code, "ECONNREFUSED");
      const err2 = await fetchWithRetry(url, { method: "POST" }, { timeoutMs: 1000, maxRetries: 0 }).then(() => null, (e) => e);
      assertClean(err2.message, "retry message");
    } finally {
      globalThis.fetch = orig;
    }
  });
  it("timeout keeps AbortError name so retry logic still works", async () => {
    const socks = new Set();
    const srv = net.createServer((c) => { socks.add(c); });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${srv.address().port}/${MARKER}`;
      const err = await fetchWithTimeout(url, {}, 150).then(() => null, (e) => e);
      assert.strictEqual(err.name, "AbortError");
      assertClean(err.message, "message");
    } finally {
      for (const c of socks) c.destroy();
      await new Promise((r) => srv.close(r));
    }
  });
});

describe("reminder webhook dispatch does not leak the webhook URL", { timeout: 30_000 }, () => {
  it("error result and logs lack the marker", async () => {
    const dir = makeTempDir("urlred-");
    try {
      const port = await closedPort();
      const calls = [];
      const logger = Object.fromEntries(["info", "warn", "error", "debug"].map((k) => [k, (...a) => calls.push([k, ...a])]));
      const rows = [{ id: "11111111-1111-1111-1111-111111111111", memoryKind: "reminder", storedBy: "a", workspaceKey: "w", remindAt: Date.now() - 1000, reminderStatus: "scheduled" }];
      const db = {
        init: async () => {},
        table: {
          query() { return this; }, where() { return this; }, limit() { return this; },
          toArray: async () => rows, update: async () => {},
        },
      };
      const result = await runReminderDispatch(db, "a", {
        workspaceDir: dir, workspaceKey: "w", logger,
        deliveryMode: "webhook",
        webhookUrl: `http://127.0.0.1:${port}/api/webhooks/1/${MARKER}?token=${MARKER}`,
      });
      assert.strictEqual(result.failed, 1);
      const warn = calls.find((c) => c[0] === "warn" && String(c[1]).includes("dispatch failed"));
      assert.ok(warn && warn[1].includes("127.0.0.1"), "failure was logged with redacted host");
      const blob = JSON.stringify({ result, calls });
      assertClean(blob, "result+logs");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
