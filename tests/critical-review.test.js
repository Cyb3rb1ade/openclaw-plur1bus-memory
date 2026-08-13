/**
 * tests/critical-review.test.js
 *
 * Regressionstests für den gemeinsamen Critical-Review-Vertrag:
 * verständliche Typ-/Grundbezeichnungen, sichere Vorschauen mit vollständiger
 * Secret-Unterdrückung, Source-Role-/False-Positive-Behandlung und
 * Kurzreferenzen (kürzestes eindeutiges UUID-Suffix, Kollision, Scope).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CRITICAL_TYPE_LABELS,
  translateType,
  translateReason,
  resolveSourceRole,
  translateSourceRole,
  isAssistantSourced,
  hasExplicitImportanceSignal,
  isEligibleForCriticalHighlight,
  isSuppressedType,
  sanitizePreview,
  buildPreview,
  SHORT_REF_MIN_LEN,
  assignShortRefs,
  normalizeShortRef,
  resolveShortRef,
  buildCriticalMessage,
} from "../lib/critical-review.js";

const UUID_A = "a4563cc9-7611-4528-992a-075f8889a018";
const UUID_B = "b4563cc9-7611-4528-992a-075f8889a019";
const UUID_C = "c4563cc9-7611-4528-992a-075f8889a028";

describe("verständliche Typbezeichnungen", () => {
  it("übersetzt alle internen Typen verständlich (de)", () => {
    assert.equal(translateType("person", "de"), "Information über eine Person");
    assert.equal(translateType("beziehung", "de"), "Persönliche Beziehung");
    assert.equal(translateType("geburtstag", "de"), "Geburtstag oder Jahrestag");
    assert.equal(translateType("geld_konto", "de"), "Finanz- oder Kontoinformation");
    assert.equal(translateType("gesundheit", "de"), "Gesundheitsinformation");
    assert.equal(translateType("zugang_passwort", "de"), "Möglicherweise sensible Zugangsinformation");
  });

  it("zeigt nie den internen Rohwert an", () => {
    assert.equal(translateType("person", "de"), "Information über eine Person");
    assert.notEqual(translateType("person", "de"), "person");
    assert.equal(translateType("__unbekannt__", "de"), "Möglicherweise besonders wichtige Erinnerung");
    assert.notEqual(translateType("__unbekannt__", "de"), "__unbekannt__");
  });
});

describe("verständliche Grundbezeichnungen", () => {
  it("übersetzt Hermes/OpenClaw-Reasons verständlich", () => {
    assert.equal(translateReason("never_forget", "", "de"), "Diese Information wurde ausdrücklich als dauerhaft wichtig markiert.");
    assert.equal(translateReason("high_importance", "", "de"), "PLUR1BUS hat diese Erinnerung als möglicherweise besonders wichtig eingestuft.");
    assert.equal(translateReason("explicit_critical_language", "", "de"), "Die Formulierung wurde als ausdrücklicher Merkwunsch erkannt.");
  });

  it("fällt bei unbekanntem Reason auf den Typ zurück, nie auf den Rohwert", () => {
    assert.equal(translateReason("__raw__", "gesundheit", "de"), "Gesundheitsinformation");
    assert.notEqual(translateReason("__raw__", "gesundheit", "de"), "__raw__");
  });
});

describe("Source-Role / Provenienz", () => {
  it("erkennt Benutzer-, Assistent- und Korrektur-Quellen", () => {
    assert.equal(resolveSourceRole({ sourceMessageRole: "user" }), "user");
    assert.equal(resolveSourceRole({ sourceMessageRole: "assistant" }), "assistant");
    assert.equal(resolveSourceRole({ sourceMessageRole: "agent" }), "assistant");
    assert.equal(resolveSourceRole({ origin: "correction" }), "correction");
    assert.equal(resolveSourceRole({}), "unknown");
  });

  it("übersetzt die Quelle verständlich", () => {
    assert.equal(translateSourceRole("user", "de"), "Benutzer");
    assert.equal(translateSourceRole("assistant", "de"), "Assistent");
    assert.equal(translateSourceRole("correction", "de"), "Korrektur");
  });

  it("Assistant-False-Positive: kein Push ohne explizites Wichtigkeitssignal", () => {
    assert.equal(isAssistantSourced({ sourceMessageRole: "assistant" }), true);
    assert.equal(isEligibleForCriticalHighlight({ sourceMessageRole: "assistant" }), false);
    assert.equal(isEligibleForCriticalHighlight({ sourceMessageRole: "assistant", type: "zugang_passwort" }), false);
  });

  it("expliziter Benutzerwunsch / neverForget / hohe Importance bleiben wirksam", () => {
    assert.equal(isEligibleForCriticalHighlight({ sourceMessageRole: "user" }), true);
    assert.equal(isEligibleForCriticalHighlight({ sourceMessageRole: "assistant", neverForget: 1 }), true);
    assert.equal(isEligibleForCriticalHighlight({ sourceMessageRole: "assistant", importance: 0.95 }), true);
    assert.equal(isEligibleForCriticalHighlight({ sourceMessageRole: "assistant", coreMemoryScore: 0.9 }), true);
  });
});

describe("Vorschau- und Datenschutzpolitik", () => {
  it("unterdrückt sensible Typen vollständig", () => {
    assert.equal(isSuppressedType("zugang_passwort"), true);
    assert.equal(isSuppressedType("gesundheit"), true);
    assert.equal(isSuppressedType("geld_konto"), true);
    assert.equal(isSuppressedType("person"), false);
  });

  it("zugang_passwort: vollständige Content-Unterdrückung", () => {
    const p = buildPreview({ type: "zugang_passwort", text: "api-key=supergeheim" }, { lang: "de" });
    assert.equal(p.suppressed, true);
    assert.equal(p.text, "");
    assert.doesNotMatch(p.reason, /supergeheim/);
    assert.match(p.reason, /ausgeblendet/);
  });

  it("gesundheit/geld_konto: konservative Unterdrückung", () => {
    for (const type of ["gesundheit", "geld_konto"]) {
      const p = buildPreview({ type, text: "private daten" }, { lang: "de" });
      assert.equal(p.suppressed, true);
      assert.equal(p.text, "");
    }
  });

  it("normalisiert, begrenzt und neutralisiert Markdown-/HTML-/Control-Injection", () => {
    const s = sanitizePreview("  Hallo\n\n*welt*  <b>fett</b> \u0007\u001f END  ", 40);
    assert.ok(!s.includes("\n"));
    assert.ok(!s.includes("*"));
    assert.ok(!s.includes("<"));
    assert.ok(!s.includes("\u0007"));
    assert.ok(s.length <= 40);
  });

  it("kürzt lange Vorschauen", () => {
    const long = "a".repeat(500);
    const s = sanitizePreview(long, 160);
    assert.ok(s.length <= 160);
    assert.ok(s.endsWith("…"));
  });

  it("leere Vorschau ergibt leeren Text", () => {
    assert.equal(sanitizePreview(""), "");
    assert.equal(sanitizePreview(undefined), "");
  });

  it("zeigt sichere Inhalte als begrenzte Vorschau", () => {
    const p = buildPreview({ type: "person", text: "Eva hat am 3. Juni Geburtstag" }, { lang: "de" });
    assert.equal(p.suppressed, false);
    assert.equal(p.text, "Eva hat am 3. Juni Geburtstag");
  });
});

describe("Kurzreferenzen", () => {
  it("erzeugt das kürzeste eindeutige Suffix (min. 5 Zeichen)", () => {
    assert.equal(SHORT_REF_MIN_LEN, 5);
    const map = assignShortRefs([UUID_A], 5);
    assert.equal(map.get(UUID_A), "9a018");
  });

  it("assignShortRefs erzeugt für jede UUID eine eindeutig auflösbare Referenz", () => {
    const ids = [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ];
    const map = assignShortRefs(ids, 5);
    const refs = [...map.values()];
    assert.equal(new Set(refs).size, refs.length, "alle Referenzen eindeutig");
    for (const ref of refs) assert.ok(ref.length >= 5);
    // Roundtrip: jede Referenz löst exakt die ursprüngliche UUID auf.
    const pending = ids.map((id) => ({ id }));
    for (const id of ids) {
      const resolved = resolveShortRef(map.get(id), pending);
      assert.equal(resolved.ok, true);
      assert.equal(resolved.id, id);
    }
  });

  it("löst Kollisionen bei identischer 5-Zeichen-Endung eindeutig auf", () => {
    // Beide enden auf ...abcde (identisches 5-Zeichen-Suffix).
    const id1 = "00000000-0000-4000-8000-aaaaaaaabcde";
    const id2 = "00000000-0000-4000-8000-bbbbbbbabcde";
    const pending = [{ id: id1 }, { id: id2 }];
    const map = assignShortRefs([id1, id2], 5);

    const ref1 = map.get(id1);
    const ref2 = map.get(id2);
    assert.ok(ref1.length >= 6, `Ref1 muss länger als 5 sein, war ${ref1}`);
    assert.ok(ref2.length >= 6, `Ref2 muss länger als 5 sein, war ${ref2}`);
    assert.notEqual(ref1, ref2);

    assert.deepEqual(resolveShortRef(ref1, pending), { ok: true, id: id1 });
    assert.deepEqual(resolveShortRef(ref2, pending), { ok: true, id: id2 });
  });

  it("löst Kollisionen bei identischer 6-Zeichen- und längerer Endung auf", () => {
    // Identisches 6-Zeichen-Suffix ...0abcde.
    const id1 = "00000000-0000-4000-8000-aaaaaa0abcde";
    const id2 = "00000000-0000-4000-8000-bbbbbb0abcde";
    const pending = [{ id: id1 }, { id: id2 }];
    const map = assignShortRefs([id1, id2], 5);

    for (const id of [id1, id2]) {
      const ref = map.get(id);
      assert.ok(ref.length >= 7, `Ref muss länger als 6 sein, war ${ref}`);
      const resolved = resolveShortRef(ref, pending);
      assert.deepEqual(resolved, { ok: true, id });
    }
  });

  it("löst mehrere UUIDs mit identischer Endung deterministisch auf", () => {
    const ids = [
      "00000000-0000-4000-8000-aaaaaaaabcde",
      "00000000-0000-4000-8000-bbbbbbbabcde",
      "00000000-0000-4000-8000-cccccccabcde",
    ];
    const pending = ids.map((id) => ({ id }));
    const map = assignShortRefs(ids, 5);
    const refs = [...map.values()];
    assert.equal(new Set(refs).size, ids.length, "keine doppelten Referenzen");
    for (const id of ids) {
      const resolved = resolveShortRef(map.get(id), pending);
      assert.deepEqual(resolved, { ok: true, id });
    }
  });

  it("ist unabhängig von der Eingabereihenfolge", () => {
    const ids = [
      "00000000-0000-4000-8000-aaaaaaaabcde",
      "00000000-0000-4000-8000-bbbbbbbabcde",
      "00000000-0000-4000-8000-cccccccabcde",
    ];
    const mapA = assignShortRefs([...ids], 5);
    const mapB = assignShortRefs([...ids].reverse(), 5);
    for (const id of ids) {
      assert.equal(mapA.get(id), mapB.get(id), `Referenz für ${id} muss reihenfolgeunabhängig sein`);
    }
  });

  it("normalisiert nur strenge Hex-Suffixe oder vollständige UUIDs", () => {
    assert.equal(normalizeShortRef("9a018").ok, true);
    assert.equal(normalizeShortRef("9a018").kind, "suffix");
    assert.equal(normalizeShortRef("ABCDE").ok, true);
    assert.equal(normalizeShortRef("abcde").value, "abcde");
    assert.equal(normalizeShortRef(UUID_A).kind, "uuid");
    assert.equal(normalizeShortRef("1234").ok, false); // zu kurz
    assert.equal(normalizeShortRef("zzzzz").ok, false); // kein hex
    assert.equal(normalizeShortRef("9a01;drop").ok, false);
  });

  it("löst eindeutige Referenz exakt auf", () => {
    const r = resolveShortRef("9a018", [{ id: UUID_A }]);
    assert.equal(r.ok, true);
    assert.equal(r.id, UUID_A);
  });

  it("unbekannte Referenz → not_found, nichts mutierbar", () => {
    const r = resolveShortRef("fffff", [{ id: UUID_A }]);
    assert.equal(r.ok, false);
    assert.equal(r.error, "not_found");
  });

  it("Kollision → ambiguous mit längeren, eindeutigen Vorschlägen", () => {
    // Zwei gültige UUIDs, die sich das letzte 5-Zeichen-Suffix teilen.
    const id1 = "00000000-0000-4000-8000-aaaaaaaabcde";
    const id2 = "00000000-0000-4000-8000-bbbbbbbabcde";
    const pending = [{ id: id1 }, { id: id2 }];
    const r = resolveShortRef("abcde", pending);
    assert.equal(r.ok, false);
    assert.equal(r.error, "ambiguous");
    assert.ok(Array.isArray(r.suggestions));
    assert.equal(r.suggestions.length, 2);
    assert.equal(new Set(r.suggestions).size, 2, "keine doppelten Vorschläge");
    // Jeder Vorschlag muss exakt eine UUID treffen.
    for (const suggestion of r.suggestions) {
      const resolved = resolveShortRef(suggestion, pending);
      assert.equal(resolved.ok, true);
    }
  });

  it("vollständige UUID bleibt kompatibler Fallback", () => {
    const r = resolveShortRef(UUID_A, [{ id: UUID_A }]);
    assert.equal(r.ok, true);
    assert.equal(r.id, UUID_A);
  });

  it("Scope-Isolation: fremde Pending-Reviews werden nicht aufgelöst", () => {
    const r = resolveShortRef("9a018", [{ id: UUID_B }]);
    assert.equal(r.ok, false);
    assert.equal(r.error, "not_found");
  });

  it("validiert die aufgelöste UUID mit dem UUID-Validator", () => {
    const r = resolveShortRef("9a018", [{ id: "kein-uuid-sondern-unsicher" }]);
    assert.equal(r.ok, false);
    assert.equal(r.error, "not_found");
  });
});

describe("Nachricht (UX-Vertrag)", () => {
  const card = {
    id: UUID_A,
    type: "geburtstag",
    title: "Evas Geburtstag",
    text: "Eva hat am 3. Juni Geburtstag.",
    sourceMessageRole: "user",
    shortRef: "9a018",
  };

  it("zeigt verständliche Texte statt interner Rohwerte", () => {
    const msg = buildCriticalMessage(card, { lang: "de" });
    assert.match(msg.text, /möglicherweise besonders wichtig erkannt/);
    assert.match(msg.text, /Geburtstag oder Jahrestag/);
    assert.match(msg.text, /Benutzer/);
    assert.doesNotMatch(msg.text, /geburtstag/);
    assert.doesNotMatch(msg.text, /reason=/);
  });

  it("zeigt Kurzreferenz und funktionierende Textbefehle", () => {
    const msg = buildCriticalMessage(card, { lang: "de" });
    assert.match(msg.text, /Referenz: 9a018/);
    assert.match(msg.text, /\/plur1bus critical accept 9a018/);
    assert.match(msg.text, /\/plur1bus critical reject 9a018/);
    assert.match(msg.text, /\/plur1bus critical edit 9a018/);
  });

  it("rendert keine toten Schalter oder Callback-Daten", () => {
    const msg = buildCriticalMessage(card, { lang: "de" });
    assert.equal(msg.inline_keyboard, undefined);
    assert.doesNotMatch(msg.text, /crit:ok/);
    assert.doesNotMatch(msg.text, /crit:no/);
    assert.doesNotMatch(msg.text, /crit:edit/);
    assert.doesNotMatch(msg.text, /callback/);
  });

  it("Reject-Hinweis stellt klar, dass nichts gelöscht wird", () => {
    const msg = buildCriticalMessage(card, { lang: "de" });
    assert.match(msg.text, /löscht die Erinnerung nicht/);
  });

  it("Nachricht enthält keine Memory-Inhalte bei unterdrückter Vorschau", () => {
    const sensitive = {
      ...card,
      type: "zugang_passwort",
      text: "api-key=supergeheim",
    };
    const msg = buildCriticalMessage(sensitive, { lang: "de" });
    assert.doesNotMatch(msg.text, /supergeheim/);
    assert.doesNotMatch(msg.text, /api-key/);
  });

  it("unterdrückte Vorschau zeigt keinen Inhalt", () => {
    const sensitive = { ...card, type: "zugang_passwort", text: "geheim" };
    const msg = buildCriticalMessage(sensitive, { lang: "de" });
    assert.doesNotMatch(msg.text, /geheim/);
    assert.match(msg.text, /ausgeblendet/);
  });
});
