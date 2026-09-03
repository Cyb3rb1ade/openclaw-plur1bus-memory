/**
 * Abbruchfehler müssen lesbar im Log stehen.
 *
 * `signal.throwIfAborted()` wirft eine DOMException, deren `message` auf dem
 * Prototyp liegt. Die strikte Eigenschaftsprüfung in `safeErrorMessage` fand
 * sie nicht, deshalb stand im Gateway-Log bei jedem Abbruch nur
 * „non-standard error" — im 8.2-Labor sichtbar als
 * „[model-preparation] failed: non-standard error" beim geordneten Beenden.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { redactError } from "../lib/safe-logging.js";

describe("redactError bei Abbruchfehlern", () => {
  it("nennt die Nachricht einer DOMException", () => {
    const controller = new AbortController();
    controller.abort();
    let thrown;
    try {
      controller.signal.throwIfAborted();
    } catch (error) {
      thrown = error;
    }
    assert.equal(thrown?.name, "AbortError");
    assert.equal(redactError(thrown).message, "This operation was aborted");
  });

  it("nennt die Nachricht einer selbst gebauten DOMException", () => {
    assert.equal(redactError(new DOMException("stopped by the operator", "AbortError")).message,
      "stopped by the operator");
  });

  it("liest weiterhin keine fremden message-Getter", () => {
    const hostile = { get message() { throw new Error("getter must not run"); } };
    assert.equal(redactError(hostile).message, "non-standard error");
  });

  it("behandelt gewöhnliche Fehler unverändert", () => {
    assert.equal(redactError(new Error("plain failure")).message, "plain failure");
    assert.equal(redactError("text").message, "text");
    assert.equal(redactError(null).message, "unknown error");
  });
});
