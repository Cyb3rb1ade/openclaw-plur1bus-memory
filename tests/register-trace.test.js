import { strict as assert } from "node:assert";
import test from "node:test";

import { formatRegistrationTrace, recordRegistration } from "../lib/register-trace.js";

const KEY = Symbol.for("plur1bus.registerTrace");

test("zählt Registrierungen je Prozess über Modulkopien hinweg", async () => {
  delete globalThis[KEY];
  let clock = 1_000;
  const first = recordRegistration({ now: () => clock, uptime: () => 12.4 });
  clock += 45_000;
  // Eine Neuladung importiert das Modul neu; der Zähler muss weiterlaufen.
  const copy = await import(`../lib/register-trace.js?reload=${Date.now()}`);
  const second = copy.recordRegistration({ now: () => clock, uptime: () => 57.6 });
  assert.equal(first.count, 1);
  assert.equal(first.sincePreviousMs, null);
  assert.equal(second.count, 2);
  assert.equal(second.sincePreviousMs, 45_000);
  assert.equal(second.uptimeSec, 58);
  delete globalThis[KEY];
});

test("Stack nur bei eingeschalteter Diagnose", () => {
  delete globalThis[KEY];
  const off = recordRegistration();
  assert.equal(off.stack, null);
  assert.equal(formatRegistrationTrace(off), null);

  const limitBefore = Error.stackTraceLimit;
  function hostLoader() {
    return recordRegistration({ enabled: true });
  }
  const on = hostLoader();
  assert.ok(on.stack.length > 0);
  assert.match(on.stack[0], /hostLoader/, "der erste Frame ist der Aufrufer, nicht der Helfer");
  assert.equal(Error.stackTraceLimit, limitBefore, "das globale Stack-Limit bleibt unverändert");
  const line = formatRegistrationTrace(on);
  assert.match(line, /^memory-lancedb-namespaced: register trace #2 \(uptime \d+s, \d+s after previous\)\n {4}at hostLoader/);
  delete globalThis[KEY];
});
