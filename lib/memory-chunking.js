/**
 * lib/memory-chunking.js — entscheidet, ob eine Erinnerung als ein Vektor
 * oder als mehrere gespeichert wird.
 *
 * Das Problem: Eine Zeile wird als EIN Vektor eingebettet. Enthält sie
 * mehrere unabhängige Aussagen, ist dieser Vektor deren Schwerpunkt und liegt
 * von jeder einzelnen weiter entfernt als nötig — die Suche findet die Zeile
 * dann nicht, obwohl die Information darin steht.
 *
 * Gemessen am 19.09.2026 (main, 9.379 aktive Zeilen): Median 5 Sätze je
 * Zeile, 75. Perzentil 14, 90. Perzentil 31, Maximum 334 Sätze in 15.000
 * Zeichen. Zugleich sind 99,7 % der im LOCOMO-Benchmark gesuchten Belege als
 * Zeile vorhanden, aber nur 75,8 % werden gefunden. Es fehlt also nichts, es
 * wird nur nicht gefunden.
 *
 * Die Entscheidung braucht in den meisten Fällen kein Modell. Verteilung im
 * Produktivbestand (main / bernhardine):
 *
 *   < 4 Sätze                    37 % / 32 %   gar nicht teilen
 *   >= 4 Sätze mit Struktur      46 % / 50 %   Regelwerk, kostenlos
 *   4–7 Sätze ohne Struktur      10 % / 17 %   ganz lassen
 *   >= 8 Sätze ohne Struktur      6 % /  1 %   satzweise (seit 7.13.0)
 *
 * Die mittlere Gruppe bleibt bewusst ganz: Fünf Sätze über EIN Thema zu
 * zerschneiden ist schlechter als sie zusammenzulassen, und ohne Modell lässt
 * sich das eine nicht vom anderen unterscheiden.
 */

/** Ab dieser Satzzahl kommt eine Aufteilung überhaupt in Betracht. */
export const CHUNK_MIN_SENTENCES = 4;
/** Ab hier lohnt bei fehlender Struktur ein Modellaufruf. */
export const CHUNK_LLM_MIN_SENTENCES = 8;
/** Kürzere Teilstücke sind Fragmente und machen keinen Vektor schärfer. */
export const CHUNK_MIN_PART_CHARS = 8;
/**
 * Obergrenze für die Zahl der Teilstücke je Erinnerung.
 *
 * Am Produktivbestand gemessen (19.09.2026): eine einzelne Zeile zerfiel in
 * bis zu 100 Stücke — das sind eingespielte Dokumente, keine Nachrichten.
 * Ohne Deckel verdreifacht sich der Bestand (main 9.379 → 32.066), und jede
 * Zeile kostet im stündlichen Cron und in jedem Backfill erneut. Über dem
 * Deckel wird gebündelt, nicht abgeschnitten: Inhalt geht nie verloren.
 */
export const CHUNK_MAX_PARTS = 20;

/**
 * Zählt, aus wie vielen eigenständigen Aussagen ein Text besteht.
 *
 * Nicht bloß Satzzeichen: Ein Punkt zwischen Ziffern (3.5 mmol/l) ist kein
 * Satzende, ein Absatzumbruch dagegen schon — auch ohne Satzzeichen. Und ein
 * Aufzählungspunkt ist eine eigene Aussage, selbst wenn er ohne Punkt endet.
 * Ohne diese letzte Regel zählte ein vierzeiliger Statusbericht als EIN Satz
 * und wurde nie geteilt, obwohl er vier unabhängige Fakten trägt (live am
 * 19.09.2026 an genau so einer Zeile aufgefallen).
 */
export function countSentences(text) {
  const value = String(text ?? "").trim();
  if (!value) return 0;

  const abschnitte = value.split(/\n\s*\n/).filter((s) => s.trim());
  let ausSatzzeichen = 0;
  for (const abschnitt of abschnitte) {
    // (?<!\d) und (?!\d) halten Dezimalzahlen und Versionsnummern zusammen.
    const enden = (abschnitt.match(/(?<!\d)[.!?…]+(?!\d)(?:\s|$)/g) || []).length;
    ausSatzzeichen += Math.max(1, enden);
  }

  const ausGliederung = value.split("\n")
    .filter((zeile) => /^\s*(?:[-*•]|\d+[.)]|#{1,6})\s+/.test(zeile)).length;

  return Math.max(ausSatzzeichen, ausGliederung);
}

/**
 * Schneidet an Strukturgrenzen: Aufzählungspunkten, nummerierten Listen,
 * Überschriften, Absätzen — in dieser Reihenfolge, weil die feinere Gliederung
 * die aussagekräftigere ist.
 *
 * @returns {string[]|null} null, wenn keine brauchbare Grenze existiert
 */
export function findStructuralParts(text) {
  const value = String(text ?? "").trim();
  if (!value) return null;

  const brauchbar = (teile) => {
    const roh = preserveShortParts(teile);
    return roh.length >= 2 ? roh : null;
  };

  // 1. Aufzählung oder nummerierte Liste. Einleitungen können Aussagen oder
  //    Einschränkungen enthalten und bleiben beim ersten Punkt erhalten.
  //    Fortsetzungszeilen gehören zum jeweiligen Punkt.
  const punkte = sammleAbschnitte(value, /^\s*(?:[-*•]|\d+[.)])\s+/, (zeile, muster) => zeile.replace(muster, ""));
  if (punkte.length >= 2) {
    const fertig = brauchbar(punkte);
    if (fertig) return fertig;
  }

  // 2. Überschriften, mit dem jeweils folgenden Abschnitt.
  const abschnitte = sammleAbschnitte(value, /^\s*#{1,6}\s+/, (zeile) => zeile);
  if (abschnitte.length >= 2) {
    const fertig = brauchbar(abschnitte);
    if (fertig) return fertig;
  }

  // 3. Absätze.
  return brauchbar(value.split(/\n\s*\n/));
}

/**
 * Sammelt Abschnitte, die jeweils mit einer Zeile beginnen, die `muster`
 * trifft. Zeilen dazwischen gehören zum laufenden Abschnitt; was vor dem
 * ersten Treffer steht, gehört zum ersten Abschnitt.
 */
function sammleAbschnitte(value, muster, kopfZeile) {
  const out = [];
  const prefix = [];
  for (const zeile of value.split("\n")) {
    if (muster.test(zeile)) out.push([kopfZeile(zeile, muster).trim()]);
    else if (out.length > 0 && zeile.trim()) out[out.length - 1].push(zeile.trim());
    else if (zeile.trim()) prefix.push(zeile.trim());
  }
  if (out.length && prefix.length) out[0].unshift(...prefix);
  return out.map((teil) => teil.join(" ").trim()).filter(Boolean);
}

/** Bundle short fragments with a neighbour instead of deleting their facts. */
function preserveShortParts(parts) {
  const out = [];
  let pending = "";
  for (const part of parts) {
    const text = [pending, part.trim()].filter(Boolean).join(" ");
    if (text.length < CHUNK_MIN_PART_CHARS) pending = text;
    else { out.push(text); pending = ""; }
  }
  if (pending && out.length) out[out.length - 1] += ` ${pending}`;
  else if (pending) out.push(pending);
  return out;
}

/**
 * Schneidet an Satzgrenzen — für Fließtext ohne Struktur.
 *
 * Dieselbe Segmentierung, mit der der Messstand am 20.09.2026 die Varianten
 * gebaut hat: erst an Zeilenumbrüchen, dann an Satzzeichen. Die Ausnahmen
 * (?<!\d) und (?!\d) halten Dezimalzahlen und Versionsnummern zusammen —
 * "3.5 mmol/l" ist kein Satzende.
 *
 * Bis 7.12.70 blieb dieser Fall ungeteilt: `planChunks` markierte ihn nur mit
 * `needsLlm` und liess ihn durch. An 90 echten Zeilen gemessen fielen dadurch
 * ALLE in den ungeteilten Zweig (whole 20, structural 0, llm 70) — die
 * Aufteilung war ausgeliefert, aber wirkungslos. Ein Modell braucht es dafür
 * nicht: Satzgrenzen erreichten im Messstand 64 % gegen 36 % für ungeteilt.
 *
 * @returns {string[]|null} null, wenn weniger als zwei brauchbare Sätze
 */
export function findSentenceParts(text) {
  const value = String(text ?? "").trim();
  if (!value) return null;
  const out = [];
  for (const block of value.split(/\n+/)) {
    const zeile = block.trim();
    if (!zeile) continue;
    for (const satz of zeile.split(/(?<=(?<!\d)[.!?…])\s+(?!\d)/)) {
      const t = satz.trim();
      if (t) out.push(t);
    }
  }
  const parts = preserveShortParts(out);
  return parts.length >= 2 ? parts : null;
}

/**
 * Der Plan für eine Erinnerung.
 *
 * `needsLlm` heißt: Das Regelwerk kommt nicht weiter, ein Modell sollte
 * schneiden. Bis dessen Antwort vorliegt, bleibt `parts` der vollständige
 * Text — eine Aufteilung wird nie geraten.
 *
 * @returns {{ mode: "whole"|"structural"|"llm", parts: string[], needsLlm: boolean, sentences: number }}
 */
export function planChunks(text, { minSentences = CHUNK_MIN_SENTENCES, llmMinSentences = CHUNK_LLM_MIN_SENTENCES } = {}) {
  const value = String(text ?? "");
  const sentences = countSentences(value);
  const ganz = { mode: "whole", parts: [value], needsLlm: false, sentences };
  if (sentences < minSentences) return ganz;

  const strukturell = findStructuralParts(value);
  if (strukturell) return { mode: "structural", parts: buendele(strukturell, CHUNK_MAX_PARTS), needsLlm: false, sentences };

  if (sentences >= llmMinSentences) {
    const saetze = findSentenceParts(value);
    // needsLlm bleibt als Kennzeichen stehen: dieser Fall KAEME fuer einen
    // Modellschnitt in Frage. Gewartet wird darauf nicht mehr — ungeteilt war
    // die schlechteste aller gemessenen Varianten.
    if (saetze) return { mode: "sentence", parts: buendele(saetze, CHUNK_MAX_PARTS), needsLlm: true, sentences };
  }
  return ganz;
}

/**
 * Fasst mehr als `max` Teilstücke zu genau `max` Bündeln zusammen, in
 * ursprünglicher Reihenfolge und ohne etwas wegzulassen.
 */
function buendele(teile, max) {
  if (teile.length <= max) return teile;
  const proBuendel = Math.ceil(teile.length / max);
  const out = [];
  for (let i = 0; i < teile.length; i += proBuendel) {
    out.push(teile.slice(i, i + proBuendel).join(" "));
  }
  return out;
}

/**
 * Setzt den Plan auf die Vorbereitungsliste des Capture-Pfads an.
 *
 * Eingabe sind die vorbereiteten Eintraege (`{ it, text, ok }`) aus Phase 1 des
 * Auto-Capture. Rueckgabe ist dieselbe Liste, nur dass aufgeteilte Eintraege
 * mehrfach vorkommen — je Teilstueck einmal, mit gemeinsamem `chunkGroupId`.
 *
 * Die Aufteilung geschieht bewusst VOR der Einbettung: nur dann bekommt jedes
 * Teilstueck einen eigenen Vektor, und genau darum geht es. Alles dahinter
 * (Dedup, Zeilenbau, Schreiben) bleibt unveraendert — jedes Teilstueck ist ab
 * hier ein ganz normaler Eintrag mit eigener ID.
 *
 * `chunkGroupId` bleibt leer, wenn nicht geteilt wurde — und ebenso auf der
 * Ursprungszeile, die bei `keepWhole` zusaetzlich erhalten bleibt. Die
 * Recall-Seite (lib/recall-pipeline.js, chunkGroupKey) faellt dann auf
 * `sourceTurnId` zurueck, so wie bisher.
 *
 * @param {Array<{it: object, text: string}>} preps
 * @param {{ enabled?: boolean, keepWhole?: boolean, makeGroupId?: () => string }} [opts]
 * @returns {{ items: Array<object>, split: number, parts: number, needsLlm: number }}
 */
export function expandForCapture(preps, { enabled = true, keepWhole = true, makeGroupId } = {}) {
  const liste = Array.isArray(preps) ? preps : [];
  if (!enabled) return { items: liste, split: 0, parts: 0, needsLlm: 0 };

  const neuerSchluessel = typeof makeGroupId === "function"
    ? makeGroupId
    : () => `cg-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

  const items = [];
  let split = 0;
  let parts = 0;
  let needsLlm = 0;

  for (const prep of liste) {
    const plan = planChunks(prep?.text);
    if (plan.needsLlm) needsLlm += 1;
    // Ein einziges Teilstueck ist keine Aufteilung — dann bleibt alles wie es war.
    if ((plan.mode !== "structural" && plan.mode !== "sentence") || plan.parts.length < 2) {
      items.push(prep);
      continue;
    }
    const gruppe = neuerSchluessel();
    split += 1;
    parts += plan.parts.length;

    // `keepWhole` speichert die Ursprungszeile ZUSAETZLICH zu den Teilen.
    //
    // Gemessen am 20.09.2026 an echten Zeilen (100 gezielt ausgewaehlte harte
    // Faelle): ganz 36 %, nur geteilt 49 %, beides 64 %. Reines Aufteilen
    // gewinnt Treffer, verliert aber Zusammenhang — die Ursprungszeile faengt
    // das ab und holt 77 % des Schadens zurueck.
    //
    // Die Ursprungszeile behaelt BEWUSST ihre leere chunkGroupId und faellt
    // damit auf sourceTurnId zurueck. Bekaeme sie dieselbe Gruppe wie die
    // Teile, wuerde der Gruppendeckel in dedupResults (DEFAULT_MAX_PER_GROUP
    // = 2) ueber alles zusammen greifen und hoechstens zwei Zeilen je
    // Nachricht durchlassen — gemessen wurde aber "Ganzes UND bis zu zwei
    // Teile". Diese Trennung ist Teil des Ergebnisses, nicht Zufall.
    if (keepWhole) items.push(prep);
    for (const teil of plan.parts) {
      items.push({ ...prep, text: teil, chunkGroupId: gruppe });
    }
  }

  return { items, split, parts, needsLlm };
}
