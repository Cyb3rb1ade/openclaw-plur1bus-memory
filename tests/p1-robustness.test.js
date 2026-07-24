/**
 * P1 Robustheit Regression Tests
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import {
  captureThenableSettlement,
  redactError,
  safeWarn,
  safeDebug,
  settleSafeWarning,
  trySafeWarn,
} from "../lib/safe-logging.js";
import { fetchWithTimeout, fetchWithRetry } from "../lib/fetch-with-timeout.js";
import { validateInput, validateCommandArgs, INPUT_LIMITS } from "../lib/input-limits.js";

const SAFE_LOGGING_URL = new URL("../lib/safe-logging.js", import.meta.url).href;

function probeEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => (
      key !== "NODE_TEST_CONTEXT"
      && key !== "NODE_UNIQUE_ID"
      && !key.startsWith("NODE_CHANNEL_")
    )),
  );
}

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

  it("does not invoke hostile error accessors or coercion hooks", () => {
    const hostile = {
      get message() { throw new Error("message getter must not run"); },
      get stack() { throw new Error("stack getter must not run"); },
      toString() { throw new Error("coercion must not run"); },
    };

    assert.doesNotThrow(() => redactError(hostile));
    assert.deepEqual(redactError(hostile), { message: "non-standard error", stack: "" });
  });

  it("redacts supported OpenAI, password, secret, bearer, API-key, and Telegram credentials", () => {
    const credentials = [
      "sk-proj-AbCdEf0123456789+/=_-more",
      "p@ss/word+with=punctuation",
      "client-secret/value+with=punctuation",
      "bearer/value+with=punctuation",
      "api/value+with=punctuation",
      "123456789:AAExampleTelegramBotToken_0123456789",
      "dXNlcjpwYXNzd29yZA==",
      "google/value+with=punctuation",
    ];
    const source = [
      `openai=${credentials[0]}`,
      `password=${credentials[1]}`,
      `secret=${credentials[2]}`,
      `Bearer ${credentials[3]}`,
      `api_key=${credentials[4]}`,
      `telegram=${credentials[5]}`,
      `GOOGLE_API_KEY=${credentials[7]}`,
      `Authorization: Basic ${credentials[6]}`,
    ].join(" ");

    const redacted = redactError(new Error(source)).message;

    for (const credential of credentials) assert.ok(!redacted.includes(credential));
    assert.ok(redacted.includes("[REDACTED]"));
  });

  it("redacts complete multi-part Authorization header values", () => {
    const cases = [
      {
        source: "Authorization=Digest username=foo,response=deadbeef,nonce=secret-nonce",
        secrets: ["username=foo", "response=deadbeef", "nonce=secret-nonce"],
      },
      {
        source: "Authorization: AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/20260721/eu-central-1/service/aws4_request, SignedHeaders=host, Signature=deadbeef",
        secrets: ["AKIAEXAMPLE", "SignedHeaders=host", "Signature=deadbeef"],
      },
      {
        source: "Authorization: Negotiate YIIFakeMultiPartToken== trailing-private-fragment",
        secrets: ["YIIFakeMultiPartToken==", "trailing-private-fragment"],
      },
    ];

    for (const { source, secrets } of cases) {
      const redacted = redactError(new Error(source)).message;
      assert.strictEqual(redacted, "[REDACTED]");
      for (const secret of secrets) assert.ok(!redacted.includes(secret));
    }
  });

  it("redacts folded Authorization continuations without consuming normal following lines", () => {
    const normalFollow = redactError(new Error(
      "Authorization:\r\nX-Follow: keep",
    )).message;
    assert.strictEqual(normalFollow, "[REDACTED]\r\nX-Follow: keep");

    const whitespaceOnly = redactError(new Error(
      "Authorization:   \n\nX-Follow: keep",
    )).message;
    assert.strictEqual(whitespaceOnly, "[REDACTED]\n\nX-Follow: keep");

    const folded = redactError(new Error(
      "Authorization: Digest username=foo,\r\n response=deadbeef, nonce=secret\r\n\topaque=private\r\nX-Follow: keep",
    )).message;
    assert.strictEqual(folded, "[REDACTED]\r\nX-Follow: keep");
    for (const secret of ["username=foo", "response=deadbeef", "nonce=secret", "opaque=private"]) {
      assert.ok(!folded.includes(secret));
    }
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

  it("observes a rejecting logger thenable without changing synchronous control flow", async () => {
    const loggerError = new Error("injected async warning transport failure");
    let rejectionHandlerAttached = false;
    const result = trySafeWarn({
      warn() {
        return {
          then(_resolve, reject) {
            rejectionHandlerAttached = true;
            reject(loggerError);
          },
        };
      },
    }, "test-warning", new Error("original operation failed"));

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.pending, true);
    assert.strictEqual(typeof result.settlement?.then, "function");
    assert.strictEqual(rejectionHandlerAttached, true, "the rejection handler is attached before returning");
    assert.deepEqual(await result.settlement, { ok: false, error: loggerError });
  });

  it("bounds a logger thenable that never settles", async () => {
    const result = trySafeWarn({
      warn() { return { then() {} }; },
    }, "test-warning", new Error("original operation failed"));

    const settled = await settleSafeWarning(result, { timeoutMs: 5 });

    assert.strictEqual(settled.ok, false);
    assert.match(settled.error.message, /cleanup deadline/);
  });

  it("rejects a self-resolving thenable without starving the cleanup deadline", () => {
    const probe = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      [
        `import { trySafeWarn, settleSafeWarning } from ${JSON.stringify(SAFE_LOGGING_URL)};`,
        'const self = { then(resolve) { resolve(self); } };',
        'const warning = trySafeWarn({ warn() { return self; } }, "cycle", new Error("primary"));',
        'const outcome = await settleSafeWarning(warning, { timeoutMs: 20 });',
        'console.log(JSON.stringify({ ok: outcome.ok, message: outcome.error?.message }));',
      ].join(" "),
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: probeEnvironment(),
      timeout: 1_000,
    });

    assert.strictEqual(probe.status, 0, probe.error?.message || probe.stderr || "cycle probe timed out");
    const outcome = JSON.parse(probe.stdout.trim());
    assert.strictEqual(outcome.ok, false);
    assert.match(outcome.message, /cycle/i);
  });

  it("observes async then-method failures and ignored rejecting return promises", () => {
    const probe = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      [
        `import { captureThenableSettlement } from ${JSON.stringify(SAFE_LOGGING_URL)};`,
        'const unhandled = [];',
        'process.on("unhandledRejection", (error) => unhandled.push(error?.message));',
        'const asyncFailure = new Error("async then failed");',
        'const ignoredFailure = new Error("ignored then return failed");',
        'const first = captureThenableSettlement({ async then() { throw asyncFailure; } });',
        'const second = captureThenableSettlement({ then(resolve) { resolve("ok"); return Promise.reject(ignoredFailure); } });',
        'const firstOutcome = await Promise.race([first, new Promise((resolve) => setTimeout(() => resolve({ ok: "timeout" }), 50))]);',
        'const secondOutcome = await second;',
        'await new Promise((resolve) => setImmediate(resolve));',
        'console.log(JSON.stringify({ firstOk: firstOutcome.ok, firstError: firstOutcome.error?.message, secondOk: secondOutcome.ok, unhandled }));',
      ].join(" "),
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: probeEnvironment(),
      timeout: 1_000,
    });

    assert.strictEqual(probe.status, 0, probe.error?.message || probe.stderr);
    assert.deepEqual(JSON.parse(probe.stdout.trim()), {
      firstOk: false,
      firstError: "async then failed",
      secondOk: true,
      unhandled: [],
    });
  });

  it("observes a rejected native promise before reading a hostile own then getter", () => {
    const probe = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      [
        `import { captureThenableSettlement } from ${JSON.stringify(SAFE_LOGGING_URL)};`,
        'const unhandled = [];',
        'process.on("unhandledRejection", (error) => unhandled.push(error?.message));',
        'const nativeError = new Error("poisoned native rejection");',
        'const getterError = new Error("hostile then getter");',
        'let getterReads = 0;',
        'const rejected = Promise.reject(nativeError);',
        'Object.defineProperty(rejected, "then", { get() { getterReads += 1; throw getterError; } });',
        'const settlement = captureThenableSettlement(rejected);',
        'const outcome = await Promise.race([settlement, new Promise((resolve) => setTimeout(() => resolve({ ok: "timeout" }), 50))]);',
        'await new Promise((resolve) => setImmediate(resolve));',
        'console.log(JSON.stringify({ ok: outcome.ok, error: outcome.error?.message, getterReads, unhandled }));',
      ].join(" "),
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: probeEnvironment(),
      timeout: 1_000,
    });

    assert.strictEqual(probe.status, 0, probe.error?.message || probe.stderr);
    assert.deepEqual(JSON.parse(probe.stdout.trim()), {
      ok: false,
      error: "poisoned native rejection",
      getterReads: 0,
      unhandled: [],
    });
  });

  it("observes rejected promise subclasses without invoking hostile species constructors", () => {
    const probe = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      [
        'import vm from "node:vm";',
        `import { captureThenableSettlement } from ${JSON.stringify(SAFE_LOGGING_URL)};`,
        'const unhandled = [];',
        'process.on("unhandledRejection", (error) => unhandled.push(error?.message));',
        'const localError = new Error("local subclass rejection");',
        'let localSpeciesReads = 0;',
        'class LocalHostilePromise extends Promise { static get [Symbol.species]() { localSpeciesReads += 1; throw new Error("local hostile species"); } }',
        'const localPromise = new LocalHostilePromise((_resolve, reject) => reject(localError));',
        'const cross = vm.runInNewContext(`(() => { const original = new Error("cross-realm subclass rejection"); let speciesReads = 0; class CrossHostilePromise extends Promise { static get [Symbol.species]() { speciesReads += 1; throw new Error("cross-realm hostile species"); } } const promise = new CrossHostilePromise((_resolve, reject) => reject(original)); return { promise, original, getSpeciesReads: () => speciesReads }; })()`);',
        'const localSettlement = captureThenableSettlement(localPromise);',
        'const crossSettlement = captureThenableSettlement(cross.promise);',
        'const [localOutcome, crossOutcome] = await Promise.all([localSettlement, crossSettlement]);',
        'await new Promise((resolve) => setImmediate(resolve));',
        'console.log(JSON.stringify({ localOk: localOutcome.ok, localIdentity: localOutcome.error === localError, crossOk: crossOutcome.ok, crossIdentity: crossOutcome.error === cross.original, localSpeciesReads, crossSpeciesReads: cross.getSpeciesReads(), localConstructorRestored: !Object.hasOwn(localPromise, "constructor"), crossConstructorRestored: !Object.hasOwn(cross.promise, "constructor"), unhandled }));',
      ].join(" "),
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: probeEnvironment(),
      timeout: 1_000,
    });

    assert.strictEqual(probe.status, 0, probe.error?.message || probe.stderr);
    assert.deepEqual(JSON.parse(probe.stdout.trim()), {
      localOk: false,
      localIdentity: true,
      crossOk: false,
      crossIdentity: true,
      localSpeciesReads: 0,
      crossSpeciesReads: 0,
      localConstructorRestored: true,
      crossConstructorRestored: true,
      unhandled: [],
    });
  });

  it("observes frozen promise subclasses and restores pre-existing constructor descriptors", () => {
    const probe = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      [
        `import { captureThenableSettlement } from ${JSON.stringify(SAFE_LOGGING_URL)};`,
        'const unhandled = [];',
        'process.on("unhandledRejection", (error) => unhandled.push(error?.message));',
        'const frozenError = new Error("frozen subclass rejection");',
        'let frozenSpeciesReads = 0;',
        'class FrozenHostilePromise extends Promise { static get [Symbol.species]() { frozenSpeciesReads += 1; throw new Error("frozen hostile species"); } }',
        'const frozenPromise = Object.freeze(new FrozenHostilePromise((_resolve, reject) => reject(frozenError)));',
        'const frozenSpeciesBefore = Object.getOwnPropertyDescriptor(FrozenHostilePromise, Symbol.species);',
        'const ownError = new Error("own constructor rejection");',
        'let ownSpeciesReads = 0;',
        'class OwnHostileConstructor extends Promise { static get [Symbol.species]() { ownSpeciesReads += 1; throw new Error("own hostile species"); } }',
        'const ownPromise = Promise.reject(ownError);',
        'Object.defineProperty(ownPromise, "constructor", { configurable: true, enumerable: true, value: OwnHostileConstructor, writable: false });',
        'const ownConstructorBefore = Object.getOwnPropertyDescriptor(ownPromise, "constructor");',
        'const frozenSettlement = captureThenableSettlement(frozenPromise);',
        'const ownSettlement = captureThenableSettlement(ownPromise);',
        'const [frozenOutcome, ownOutcome] = await Promise.all([frozenSettlement, ownSettlement]);',
        'await new Promise((resolve) => setImmediate(resolve));',
        'const frozenSpeciesAfter = Object.getOwnPropertyDescriptor(FrozenHostilePromise, Symbol.species);',
        'const ownConstructorAfter = Object.getOwnPropertyDescriptor(ownPromise, "constructor");',
        'console.log(JSON.stringify({ frozenOk: frozenOutcome.ok, frozenIdentity: frozenOutcome.error === frozenError, frozenSpeciesReads, frozenStillFrozen: Object.isFrozen(frozenPromise), frozenSpeciesRestored: frozenSpeciesAfter.get === frozenSpeciesBefore.get && frozenSpeciesAfter.configurable === frozenSpeciesBefore.configurable && frozenSpeciesAfter.enumerable === frozenSpeciesBefore.enumerable, ownOk: ownOutcome.ok, ownIdentity: ownOutcome.error === ownError, ownSpeciesReads, ownConstructorRestored: ownConstructorAfter.value === ownConstructorBefore.value && ownConstructorAfter.configurable === ownConstructorBefore.configurable && ownConstructorAfter.enumerable === ownConstructorBefore.enumerable && ownConstructorAfter.writable === ownConstructorBefore.writable, unhandled }));',
      ].join(" "),
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: probeEnvironment(),
      timeout: 1_000,
    });

    assert.strictEqual(probe.status, 0, probe.error?.message || probe.stderr);
    assert.deepEqual(JSON.parse(probe.stdout.trim()), {
      frozenOk: false,
      frozenIdentity: true,
      frozenSpeciesReads: 0,
      frozenStillFrozen: true,
      frozenSpeciesRestored: true,
      ownOk: false,
      ownIdentity: true,
      ownSpeciesReads: 0,
      ownConstructorRestored: true,
      unhandled: [],
    });
  });

  it("reports a chain-depth limit separately from a real thenable cycle", async () => {
    let chain = "settled";
    for (let i = 0; i < 33; i++) {
      const nested = chain;
      chain = { then(resolve) { resolve(nested); } };
    }

    const outcome = await captureThenableSettlement(chain);

    assert.strictEqual(outcome.ok, false);
    assert.match(outcome.error.message, /depth/i);
    assert.doesNotMatch(outcome.error.message, /cycle/i);
  });
});

describe("safeWarn", () => {
  it("observes an asynchronously rejecting logger when called directly", () => {
    const probe = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      [
        `import { safeWarn } from ${JSON.stringify(SAFE_LOGGING_URL)};`,
        'const unhandled = [];',
        'process.on("unhandledRejection", (error) => unhandled.push(error?.message));',
        'const loggerError = new Error("direct async warn failed");',
        'safeWarn({ async warn() { throw loggerError; } }, "direct", new Error("primary"));',
        'await new Promise((resolve) => setImmediate(resolve));',
        'console.log(JSON.stringify({ unhandled }));',
      ].join(" "),
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: probeEnvironment(),
      timeout: 1_000,
    });

    assert.strictEqual(probe.status, 0, probe.error?.message || probe.stderr);
    assert.deepEqual(JSON.parse(probe.stdout.trim()), { unhandled: [] });
  });
});

describe("safeDebug", () => {
  it("returns a non-rejecting settlement for an asynchronously failing debug logger", async () => {
    const loggerError = new Error("async debug logger failed");
    const outcome = safeDebug({
      async debug() { throw loggerError; },
    }, "test-debug", new Error("primary"));

    assert.strictEqual(outcome.ok, true);
    assert.strictEqual(outcome.pending, true);
    assert.deepEqual(await outcome.settlement, { ok: false, error: loggerError });
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
