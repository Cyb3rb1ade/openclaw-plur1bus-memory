import { strict as assert } from "node:assert";
import { AsyncLocalStorage } from "node:async_hooks";
import test from "node:test";

import { createPostTurnDetacher } from "../lib/post-turn-detach.js";
import { errorHint } from "../lib/llm-router.js";

// Stand-in for OpenClaw's gatewayToolCallerStorage and runtime.llm: a completion
// inside an inherited (revoked) turn identity is refused, outside it succeeds.
const callerStorage = new AsyncLocalStorage();
async function fakeComplete() {
  await new Promise((resolve) => setImmediate(resolve));
  if (callerStorage.getStore()) {
    throw Object.assign(new Error("agent tool caller authority is no longer active"), {
      name: "LlmCompleteError", code: "LLM_COMPLETION_NOT_AUTHORIZED",
    });
  }
  return { text: "ok" };
}

// Mirrors the capture queue: the task is enqueued inside the turn and runs later.
function runInTurn(wrap) {
  return callerStorage.run({ turn: 1 }, () => new Promise((resolve, reject) => {
    const task = wrap(async () => fakeComplete());
    setTimeout(() => { Promise.resolve().then(task).then(resolve, reject); }, 5);
  }));
}

test("eingeschaltet laeuft die Nachbearbeitung ausserhalb des Turns", async () => {
  const detach = createPostTurnDetacher({ enabled: true });
  assert.deepEqual(await runInTurn(detach), { text: "ok" });
});

test("ausgeschaltet bleibt alles wie bisher, die geerbte Turn-Identitaet scheitert", async () => {
  const detach = createPostTurnDetacher();
  await assert.rejects(runInTurn(detach), /no longer active/);
});

test("Argumente und Rueckgabewert der Aufgabe bleiben erhalten", async () => {
  const detach = createPostTurnDetacher({ enabled: true });
  const wrapped = detach(async (signal, extra) => ({ aborted: signal.aborted, extra }));
  assert.deepEqual(await wrapped({ aborted: false }, 42), { aborted: false, extra: 42 });
});

test("ohne snapshot-API faellt der Schalter auf die bisherige Ausfuehrung zurueck", () => {
  const task = () => 1;
  assert.equal(createPostTurnDetacher({ enabled: true, snapshot: undefined })(task), task);
});

test("abgelaufene Turn-Berechtigung bekommt eine eigene Fehlerkategorie", () => {
  assert.equal(errorHint(new Error("agent tool caller authority is no longer active")), "authority-expired");
  assert.equal(errorHint(new Error("Plugin LLM completion is not bound to an active session agent.")), "authority-expired");
});
