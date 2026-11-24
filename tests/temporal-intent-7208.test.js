/**
 * 7.20.8: Der Zeitfilter nach createdAt greift nur noch bei Fragen nach der
 * Gesprächszeit („was haben wir gestern besprochen“). Ereigniszeit,
 * beiläufige, kalendarische Angaben und Anker filtern nicht.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CAPTURE_GRACE_MS,
  CONVERSATION_QUERY_MAX_CHARS,
  classifyTemporalQuery,
  parseTemporal,
  parseTemporalLegacy,
  stripDurationPhrases,
  stripTemporalNoise,
} from "../lib/temporal-parser.js";
import { generateProactiveNudge } from "../lib/proactive-nudge.js";
import { runRecallPipeline } from "../lib/recall-pipeline.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-24T12:00:00Z"); // Dienstag
const TODAY = Date.parse("2026-11-24T00:00:00Z");
const YESTERDAY = TODAY - DAY;

function classify(query, now = NOW) {
  return classifyTemporalQuery(query, now);
}

describe("classifyTemporalQuery: Gesprächszeit filtert hart", () => {
  const hard = [
    ["was haben wir gestern besprochen", "yesterday"],
    ["Was haben wir heute besprochen?", "today"],
    ["Die Daten hatte ich dir doch gestern gegeben", "yesterday"],
    ["Ich hab dir gestern erzählt, wie das Auto klingt", "yesterday"],
    ["Was hast du mir am Montag gesagt?", "weekday"],
    ["Du hast mir vor 2 Tagen ein Rezept geschickt", "daysAgo"],
    ["Wir haben uns doch letzte Woche über das Dach unterhalten, oder?", "lastWeek"],
    ["Worüber haben wir letzten Monat geredet?", "lastMonth"],
    ["Deine Zusammenfassung von gestern war zu lang", "yesterday"],
    ["Was hast du gestern gemacht?", "yesterday"],
    ["Hast du heute schon die Mails gecheckt?", "today"],
    ["Guten Morgen, was hast du gestern geschickt?", "yesterday"],
    ["Was haben wir gestern erledigt?", "yesterday"],
    ["Der Nutzer hat gestern etwas über Kaffee erzählt", "yesterday"],
    ["what did I tell you last week", "lastWeek"],
    ["what did we do yesterday", "yesterday"],
    ["What did we discuss yesterday?", "yesterday"],
    ["You recommended a book to me 3 days ago", "daysAgo"],
    ["I sent you the invoice yesterday", "yesterday"],
    ["Did you send the report today?", "today"],
    ["what did the user say yesterday about the car", "yesterday"],
    ["the user mentioned a dentist appointment 2 hours ago", "hoursAgo"],
    ["Can you find our conversation from yesterday", "yesterday"],
  ];
  for (const [query, kind] of hard) {
    it(`${query} -> hart (${kind})`, () => {
      const c = classify(query);
      assert.equal(c?.mode, "hard", JSON.stringify(c));
      assert.equal(c.kind, kind);
      assert.equal(c.reason, "conversation-time");
    });
  }

  it("Sprachnachricht: Umschlag weg, Text bleibt — Fenster gestern ±2 h", () => {
    const c = classify("[Audio transcript (machine-generated, untrusted)] was hab ich dir gestern über das Auto erzählt");
    assert.equal(c.mode, "hard");
    assert.equal(c.kind, "yesterday");
    assert.deepEqual(c.range, { from: YESTERDAY - CAPTURE_GRACE_MS, to: TODAY + CAPTURE_GRACE_MS });
    assert.equal(CAPTURE_GRACE_MS, 2 * HOUR);
  });

  it("das Fenster endet höchstens bei now (heute, kurz nach Mitternacht)", () => {
    const now = TODAY + 30 * 60_000;
    const today = classify("Was haben wir heute besprochen?", now);
    assert.deepEqual(today.range, { from: TODAY - CAPTURE_GRACE_MS, to: now });
    const yesterday = classify("was haben wir gestern besprochen", now);
    assert.deepEqual(yesterday.range, { from: YESTERDAY - CAPTURE_GRACE_MS, to: now });
  });

  it("das Fenster kommt aus dem Teilsatz mit dem Gesprächsbezug", () => {
    const c = classify("Heute regnet es. Was hast du mir gestern über das Dach gesagt?");
    assert.equal(c.mode, "hard");
    assert.equal(c.kind, "yesterday");
    assert.deepEqual(c.range, { from: YESTERDAY - CAPTURE_GRACE_MS, to: TODAY + CAPTURE_GRACE_MS });
  });
});

describe("classifyTemporalQuery: alles andere filtert nicht", () => {
  const notHard = [
    // Gespräche mit Dritten, Ereignisse Dritter
    "ich habe heute mit Lorenzo gesprochen",
    "Erik hatte gestern Besuch",
    "Hast du gehört, was heute in Berlin passiert ist?",
    "Hast du gehört was heute in Berlin passiert ist?",
    "Schreib ihm: du hattest heute recht",
    "Kannst du mir sagen, was Eva gestern gemacht hat?",
    "Kannst du mir sagen was Eva gestern gemacht hat?",
    "I talked to Lorenzo today",
    "Can you tell me what Eva did yesterday?",
    "Did you hear what happened in Berlin today?",
    // kein Gesprächsbezug
    "Was war gestern?",
    "Wie soll ich denn heute arbeiten?!",
    "Wir haben heute den Zaun gemacht",
    // Fristen
    "Erinnere mich bis heute Abend an den Anruf",
    "Das muss bis heute 18 Uhr raus",
    // Zeit steht im dass-Teilsatz, nicht im Sprechakt
    "Ich hab dir gesagt, dass er am Donnerstag kommt",
    // Zukunft
    "Was hab ich dir gestern über morgen gesagt?",
    "What did I tell you yesterday about the next trip?",
    // LOCOMO
    "Where was Calvin located in the last week of October 2026?",
    "Which band was Dave's favorite at the music festival in April 2026?",
    "What sports activity is Calvin planning to try after the tour with Frank Ocean?",
    "When did James try Cyberpunk 2077 game?",
    "What type of date is Andrew going on Sunday?",
    // LME
    "How many hours of jogging and yoga did I do last week?",
    "Which pair of shoes did I clean last month?",
  ];
  for (const query of notHard) {
    it(`${query} -> nicht hart`, () => {
      const c = classify(query);
      assert.notEqual(c?.mode, "hard", JSON.stringify(c));
    });
  }

  it("Review: Komposita sind kein Gesprächsbezug, nur die Wörter selbst", () => {
    for (const q of [
      "In unserer Chatgruppe hat heute jemand gefragt wer kommt",
      "Was melden deine Nachrichtenquellen heute?",
      "Unser Gesprächspartner von der Bank hat gestern angerufen",
      "Ist deine Antwortzeit heute langsamer?",
      "Unser Chatbot lief gestern nicht",
      "Deine Antwortqualität letzte Woche war schlecht",
      "Deine Listenansicht war heute kaputt",
    ]) {
      assert.notEqual(classify(q)?.mode, "hard", q);
    }
    for (const q of [
      "Was stand gestern in deiner Nachricht?",
      "Worum ging es in unserem Gespräch gestern?",
      "deine Antworten von gestern",
      "Deine Liste von gestern bitte nochmal",
      "Unsere Chats von gestern",
      "Show me your messages from yesterday",
    ]) {
      assert.equal(classify(q)?.mode, "hard", q);
    }
  });

  it("Review: „the user said“ nur mit Artikel — „a user said“ ist ein Dritter", () => {
    for (const q of [
      "a user said yesterday on reddit that python is slow",
      "some user told me yesterday the API is down",
      "every user asked yesterday about the outage",
      "one user mentioned last week that it crashed",
    ]) {
      assert.notEqual(classify(q)?.mode, "hard", q);
    }
    assert.equal(classify("the user said yesterday that python is slow")?.mode, "hard");
  });

  it("Gründe: kein Gesprächsbezug, Zukunft, absolute Zeit, Anker", () => {
    assert.deepEqual(classify("Was war gestern?"), {
      mode: "none", kind: "yesterday", range: { from: YESTERDAY, to: TODAY }, reason: "no-conversation-cue",
    });
    assert.equal(classify("Was hab ich dir gestern über morgen gesagt?").reason, "future");
    const absolute = classify("Which band was Dave's favorite at the music festival in April 2026?");
    assert.deepEqual(absolute, {
      mode: "none",
      kind: "monthYear",
      range: { from: Date.UTC(2026, 3, 1), to: Date.UTC(2026, 4, 1) },
      reason: "absolute-time",
    });
    assert.equal(classify("Wir haben im Mai über das Dach gesprochen").reason, "absolute-time");
    assert.equal(classify("Was haben wir 2025 besprochen?")?.mode ?? "none", "none");
    assert.deepEqual(classify("What sports activity is Calvin planning to try after the tour with Frank Ocean?"), {
      mode: "none", kind: "anchor", range: null, reason: "anchor",
    });
  });

  it("keine Zeitangabe -> null", () => {
    assert.equal(classify("When did James try Cyberpunk 2077 game?"), null);
    assert.equal(classify("Was hast du mir über das Auto gesagt?"), null);
    assert.equal(classify(""), null);
    assert.equal(classify(null), null);
  });

  it("heute Morgen / gestern Morgen / Guten Morgen sind keine Zukunft", () => {
    assert.equal(classify("Was hab ich dir heute Morgen erzählt?").mode, "hard");
    assert.equal(classify("Was hast du mir gestern Morgen geschickt?").mode, "hard");
    assert.equal(classify("Guten Morgen was hast du gestern geschickt?").mode, "hard");
  });

  it(`eingefügte Dokumente (> ${CONVERSATION_QUERY_MAX_CHARS} Zeichen) filtern nie hart`, () => {
    const filler = "Absatz ohne Zeitbezug. ".repeat(80);
    const c = classify(`${filler}\nWas hab ich dir gestern gesagt?`);
    assert.equal(c.mode, "none");
    assert.equal(c.reason, "long-message");
    // Umschlag, Pfade und Code zählen nicht zur Länge.
    const code = "```\n" + "x = 1\n".repeat(400) + "```";
    assert.equal(classify(`${code}\nWas hab ich dir gestern gesagt?`).mode, "hard");
  });
});

describe("classifyTemporalQuery: Review — Zeitangabe gehört zum Sprechakt", () => {
  const now = Date.UTC(2026, 10, 24, 10, 30);
  const c = (q) => classifyTemporalQuery(q, now);

  it("zwei verschiedene Zeitangaben am Sprechakt sind nicht eindeutig", () => {
    for (const q of [
      "Was hast du mir gestern über den Termin heute gesagt?",
      "Was hab ich dir gestern über heute Abend erzählt?",
      "What did I tell you yesterday about today's meeting?",
      "What did you tell me last week about yesterday's game?",
      "Was hast du mir am Montag über den Termin am Freitag gesagt?",
    ]) {
      const r = c(q);
      assert.equal(r?.mode, "none", q);
      assert.equal(r.reason, "ambiguous-time", q);
    }
    // Eine Angabe: das Fenster dieser Angabe, nicht die erste nach Rang.
    assert.deepEqual(c("Was hast du mir gestern gesagt?").range, {
      from: Date.UTC(2026, 10, 23) - CAPTURE_GRACE_MS, to: Date.UTC(2026, 10, 24) + CAPTURE_GRACE_MS,
    });
    // Steht die zweite Angabe in einem anderen Teilsatz, bleibt es eindeutig.
    const split = c("Ich hab dir gestern gesagt, dass er heute kommt");
    assert.equal(split.mode, "hard");
    assert.equal(split.kind, "yesterday");
  });

  it("Objektsatz ohne Komma: die Zeit gehört zum Gesagten, nicht zum Sagen", () => {
    for (const q of [
      "Ich hab dir gesagt dass er am Donnerstag kommt",
      "ich hab dir gesagt dass er am donnerstag kommt",
      "Hab ich dir erzählt dass ich gestern beim Arzt war",
      "das hatte ich dir doch erzählt dass meine Mutter heute morgen beim Arzt war",
      "Du hast gesagt der Termin ist am Freitag",
      "du hast gesagt das paket kommt am freitag",
      "I told you he's coming on Thursday",
      "I told you that he is coming on Thursday",
      "Did I tell you that Eva called yesterday?",
      "Did I tell you my sister had her baby yesterday?",
      "You said the package arrives on Friday",
      "You said the delivery comes on Friday",
      "You said the dentist appointment is on Friday",
      "I told you what happened yesterday",
      "und ich weiß nicht ob ich dir das vorhin schon erzählt hatte aber heute morgen um 9 uhr hat er angerufen",
    ]) {
      assert.notEqual(c(q)?.mode, "hard", q);
    }
  });

  it("Nebensatz mit Fragewort über Dritte, ohne Komma", () => {
    for (const q of [
      "Hast du gehört was Eva heute gemacht hat?",
      "hast du gesehen was eva heute gemacht hat",
      "hast du mitbekommen was erik gestern geschickt hat",
    ]) {
      assert.notEqual(c(q)?.mode, "hard", q);
    }
    // „was“ als „etwas“: kein Nebensatz, bleibt hart.
    assert.equal(c("Hast du mir gestern was geschickt?").mode, "hard");
  });

  it("Diktat für Dritte nach Doppelpunkt zählt nicht; „Sag mal:“ schon", () => {
    for (const q of [
      "Schreib Eva: danke für deine Nachricht von gestern",
      "Schreib ihm: du hast mir gestern das Paket geschickt, danke",
      "Antworte Lorenzo: danke für deine Nachricht von gestern",
      "Tell Eva: you said yesterday you'd bring the cake",
      "Reply to Mark: thanks for your message yesterday",
    ]) {
      assert.notEqual(c(q)?.mode, "hard", q);
    }
    for (const q of [
      "Sag mal: was haben wir gestern besprochen?",
      "Sag mir: was hab ich dir gestern erzählt?",
      "Tell me: what did we discuss yesterday?",
    ]) {
      assert.equal(c(q)?.mode, "hard", q);
    }
  });

  it("die Zeit beim Sprechakt bleibt hart, auch mit Objektsatz dahinter", () => {
    for (const q of [
      "You said that yesterday",
      "Did I tell you that yesterday?",
      "Ich hab dir doch gestern gesagt dass ich keine Pilze mag",
      "You told me 2 days ago that the API was down",
      "Was hab ich dir erzählt gestern?",
      "the user said yesterday that python is slow",
    ]) {
      assert.equal(c(q)?.mode, "hard", q);
    }
  });

  it("unpunktierte Sprachnachricht: Zeit weit weg vom Sprechakt filtert nicht", () => {
    const q = "also gestern war ich bei der bank und die meinten der kredit geht wahrscheinlich durch aber die wollen noch die gehaltsnachweise von den letzten drei monaten und das hab ich dir ja schon erzählt dass mein chef die nicht rausrückt";
    assert.notEqual(c(q)?.mode, "hard");
  });

  it("Zukunft gilt für den ganzen Teilsatz, auch vor einem Nebensatz", () => {
    assert.equal(c("Tomorrow I'll tell you what we discussed today")?.mode, "none");
    assert.equal(c("Tomorrow I'll tell you what we discussed today").reason, "future");
  });

  it("Verb am Ende (Nebensatz nach „Weißt du noch“) ist Gesprächsbezug", () => {
    for (const [q, kind] of [
      ["Weißt du noch, was wir gestern besprochen haben?", "yesterday"],
      ["Weißt du noch was wir gestern besprochen haben?", "yesterday"],
      ["Erinnerst du dich, was ich dir gestern gesagt habe?", "yesterday"],
      ["Was ich dir gestern gesagt habe, stimmt nicht", "yesterday"],
      ["Weißt du noch, was ich dir am Freitag erzählt habe?", "weekday"],
      ["Weißt du noch worüber wir gestern gesprochen haben?", "yesterday"],
      ["Was war das nochmal, was du mir gestern geschickt hast?", "yesterday"],
      ["Kannst du nochmal sagen was du mir gestern geschrieben hast", "yesterday"],
      ["Kannst du mir sagen, was ich dir heute früh erzählt habe?", "today"],
      ["Zeig mir, was wir letzte Woche ausgemacht haben", "lastWeek"],
      ["Weißt du noch, was wir gestern gemacht haben?", "yesterday"],
      ["hey what did we chat about today", "today"],
    ]) {
      const r = c(q);
      assert.equal(r?.mode, "hard", q);
      assert.equal(r.kind, kind, q);
    }
    for (const q of [
      "Weißt du noch, was ich heute mit Lorenzo gesprochen habe?",
      "Weißt du noch, mit wem ich gestern gesprochen habe?",
      "Ich erzähl dir was wir gestern gemacht haben",
    ]) {
      assert.notEqual(c(q)?.mode, "hard", q);
    }
  });
});

describe("parseTemporal 7.20.8: kind und Parser-Korrekturen", () => {
  it("Range-Ergebnisse tragen kind, das Format bleibt", () => {
    const cases = [
      ["heute", "today"], ["gestern", "yesterday"], ["vor 3 Tagen", "daysAgo"], ["vor 4 Stunden", "hoursAgo"],
      ["letzte Woche", "lastWeek"], ["letzten Monat", "lastMonth"], ["am Montag", "weekday"],
      ["im Mai 2025", "monthYear"], ["im Mai", "month"], ["in 2025", "year"],
    ];
    for (const [phrase, kind] of cases) {
      const r = parseTemporal(phrase, NOW);
      assert.equal(r?.type, "range", phrase);
      assert.equal(r.kind, kind, phrase);
      assert.equal(typeof r.from, "number");
      assert.equal(typeof r.to, "number");
    }
    assert.deepEqual(parseTemporal("what happened after the docker setup", NOW), { type: "anchor", referenceQuery: "docker setup" });
  });

  it("„last week of October 2026“ ist der Oktober, nicht die letzte Woche", () => {
    assert.deepEqual(parseTemporal("Where was Calvin located in the last week of October 2026?", NOW), {
      type: "range", from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 10, 1), kind: "monthYear",
    });
    assert.deepEqual(parseTemporal("the first weekend of May 2025", NOW), {
      type: "range", from: Date.UTC(2025, 4, 1), to: Date.UTC(2025, 5, 1), kind: "monthYear",
    });
    const de = parseTemporal("Was war in der letzten Woche im Oktober?", NOW);
    assert.equal(de.kind, "month");
    assert.equal(de.from, Date.UTC(2026, 9, 1));
    assert.equal(parseTemporal("erstes Wochenende des Oktobers 2025", NOW).kind, "monthYear");
  });

  it("Jahreszahl nur, wenn sie als Jahr erkennbar ist", () => {
    assert.equal(parseTemporal("When did James try Cyberpunk 2077 game?", NOW), null);
    assert.equal(parseTemporal("Fehler in openclaw.json:2253, bitte prüfen", NOW), null);
    assert.equal(parseTemporal("siehe Zeile 2253:14 und lib/recall-pipeline.js:1885", NOW), null);
    assert.equal(parseTemporal("[media attached: /root/.openclaw/media/inbound/3f2a2990-1b2c-4d5e-8f90-123456789abc.jpg (image/jpeg)] Schau mal", NOW), null);
    assert.equal(parseTemporal("id 7e3f-2990-ab ist kaputt", NOW), null);
    assert.equal(parseTemporal("2000 Zeichen reichen nicht", NOW), null);
    assert.equal(parseTemporal("Der Veranstaltungsplan 2027 ist da", NOW), null);
    assert.equal(parseTemporal("Beschluss vom 06.10.2025", NOW), null);
    assert.equal(parseTemporal("2026-10-24 war ein Samstag", NOW), null);
    assert.equal(parseTemporal("Scan 30. Sept. 2026.pdf", NOW), null);
    for (const q of ["Was war 2025?", "2025 war ein gutes Jahr", "im Jahr 1987", "seit 2020", "since 2019", "until 2030", "in the year 2001"]) {
      assert.equal(parseTemporal(q, NOW)?.kind, "year", q);
    }
    assert.equal(parseTemporal("Was war 2025?", NOW).from, Date.UTC(2025, 0, 1));
  });

  it("Review: kleingeschriebene Namen, Zeilennummern und Mengen sind kein Jahr", () => {
    for (const q of [
      "ich spiele gerade cyberpunk 2077.",
      "guck mal in zeile 2253.",
      "In 2000 Metern links abbiegen",
      "in 2000 metern links",
      "kostet 2000.",
      "bis 2000 Euro",
      "seite 2010.",
    ]) {
      assert.equal(parseTemporal(q, NOW), null, q);
    }
    for (const q of ["seit 2020 läuft das", "von 2019 bis 2021.", "das war 2019.", "Anfang 2024.", "2024 kam der Umzug"]) {
      assert.equal(parseTemporal(q, NOW)?.kind, "year", q);
    }
  });

  it("Monat, Wochentag: auch spätere Fundstellen zählen", () => {
    assert.equal(parseTemporal("im Büro war im Mai viel los", NOW)?.kind, "month");
    assert.equal(parseTemporal("am besten am Montag", NOW)?.kind, "weekday");
    assert.equal(parseTemporal("im Jahr danach, im Mai 2024", NOW)?.kind, "monthYear");
  });

  it("Dauerphrasen „seit …“ / „since …“ ergeben kein Fenster", () => {
    for (const q of ["seit gestern geht nichts", "seit heute läuft es", "seit letzter Woche kaputt", "seit letztem Monat ruhig", "since yesterday nothing works", "since last week", "since last month"]) {
      assert.equal(parseTemporal(q, NOW), null, q);
    }
    assert.equal(stripDurationPhrases("Seit gestern nichts").trim(), "nichts");
  });
});

describe("stripTemporalNoise", () => {
  it("entfernt nur den Umschlag, nicht den Text der Sprachnachricht", () => {
    const out = stripTemporalNoise("[Audio transcript (machine-generated, untrusted)] was hab ich dir gestern erzählt");
    assert.equal(out.trim(), "was hab ich dir gestern erzählt");
    assert.equal(stripTemporalNoise("[media attached: /a/b/c.jpg (image/jpeg)] Schau mal").trim(), "Schau mal");
    assert.equal(stripTemporalNoise("[Image: foo 2990] und [user sent media: x] und [voice message 12s] Text").replace(/\s+/g, " ").trim(), "und und Text");
  });

  it("entfernt Code, URLs, Pfade, datei:zeile, UUIDs und Hex-Folgen", () => {
    const out = stripTemporalNoise(
      "a ```const y = 2025;``` b `2026` c https://example.com/2025/x d /root/.openclaw/2990.json e lib/x/y.js:2253 f 3f2a2990-1b2c-4d5e-8f90-123456789abc g 17f08746 h",
    ).replace(/\s+/g, " ").trim();
    assert.equal(out, "a b c d e f g h");
  });

  it("lässt Datumsangaben und Wortpaare mit Schrägstrich stehen", () => {
    assert.equal(stripTemporalNoise("am 24/10/2026"), "am 24/10/2026");
    assert.equal(stripTemporalNoise("heute/gestern und/oder"), "heute/gestern und/oder");
    assert.equal(stripTemporalNoise("Termin 24.10.2026"), "Termin 24.10.2026");
  });
});

describe("Laufzeit bleibt linear", () => {
  it("lange Tokens (Base64, Pfadketten, Hex, offene Umschläge) kosten keine Sekunden", () => {
    const inputs = [
      "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo".repeat(2000) + " gestern",
      "a.b.c.d.e.f.g.h.".repeat(4000) + " heute",
      "abc/def/".repeat(6000) + " heute",
      "deadbeef".repeat(8000) + " gestern",
      "[media attached ".repeat(3000) + " heute",
      "2026 ".repeat(10000),
      // unter der Längengrenze: Teilsatz-Schnitte und Fragewörter
      "was hab ich dir gesagt dass ob ".repeat(45) + " gestern",
      "I told you that he said she ".repeat(50) + " yesterday",
      "was wer wie wo ".repeat(90) + " gestern hat",
      " ".repeat(200000) + "Was hab ich dir gestern gesagt?",
    ];
    for (const q of inputs) {
      const t0 = performance.now();
      classifyTemporalQuery(q, NOW);
      parseTemporal(q, NOW);
      const ms = performance.now() - t0;
      assert.ok(ms < 2000, `${q.length} Zeichen: ${ms.toFixed(0)} ms`);
    }
  });
});

describe("proactive-nudge: Phrasen bleiben erkannt", () => {
  it("parseTemporal ist für alle Nudge-Phrasen truthy", () => {
    for (const phrase of ["gestern", "vor 2 Tagen", "vor 3 Tagen", "letzte Woche", "letzten Monat"]) {
      assert.ok(parseTemporal(phrase, NOW), phrase);
    }
    assert.equal(parseTemporal("in letzter Zeit", NOW), null);
  });

  it("der Nudge-Text nennt weiter die Zeitphrase", () => {
    const expected = [[20, "gestern"], [40, "vor 2 Tagen"], [60, "vor 3 Tagen"], [100, "letzte Woche"], [300, "letzten Monat"]];
    for (const [recencyHours, phrase] of expected) {
      const nudge = generateProactiveNudge({ now: NOW }, [{ keyword: "docker", occurrences: 5, score: 0.9, recencyHours }]);
      assert.ok(nudge.text.includes(`Du hast ${phrase} mehrmals`), nudge.text);
    }
  });
});

describe("parseTemporalLegacy: 7.20.7 unverändert", () => {
  it("rollierende Woche, Jahr aus Namen, kein kind", () => {
    assert.deepEqual(parseTemporalLegacy("Where was Calvin located in the last week of October 2026?", NOW), {
      type: "range", from: NOW - 7 * DAY, to: NOW,
    });
    assert.deepEqual(parseTemporalLegacy("When did James try Cyberpunk 2077 game?", NOW), {
      type: "range", from: Date.UTC(2077, 0, 1), to: Date.UTC(2078, 0, 1),
    });
    assert.deepEqual(parseTemporalLegacy("seit gestern geht nichts", NOW), {
      type: "range", from: YESTERDAY, to: TODAY,
    });
    assert.equal(parseTemporalLegacy("Bis jetzt hat sich niemand gemeldet.", NOW), null);
    assert.deepEqual(parseTemporalLegacy("what happened after the docker setup", NOW), { type: "anchor", referenceQuery: "docker setup" });
  });
});

// ─── Pipeline ───────────────────────────────────────────────────────────────

const embeddings = { dim: 3, embed: async () => [0.1, 0.2, 0.3], embedQuery: async () => [0.1, 0.2, 0.3] };
const TEXTS = {
  y: "river stone bridge morning walk",
  grace: "mountain cloud winter cabin trip",
  old: "harbor ferry ticket evening ride",
  apr: "picnic garden friends lunch spring",
};
function row(id, distance, createdAt) {
  return {
    id, text: TEXTS[id] || `memory ${id}`, _distance: distance, createdAt,
    scope: "agent-private", agentId: "agent-a", storedBy: "agent-a",
  };
}
function countingTable(rows) {
  const calls = { vectorSearch: 0 };
  return {
    calls,
    vectorSearch: () => {
      calls.vectorSearch++;
      return { limit: () => ({ toArray: async () => rows }) };
    },
  };
}
function capturingLogger() {
  const lines = [];
  const push = (msg) => lines.push(String(msg));
  return { lines, logger: { info: push, warn: push, debug: push } };
}
async function recall(query, rows, extra = {}) {
  const table = countingTable(rows);
  const embedCalls = [];
  const emb = {
    dim: 3,
    embed: async (text) => { embedCalls.push(text); return [0.1, 0.2, 0.3]; },
    embedQuery: async () => [0.1, 0.2, 0.3],
  };
  const { lines, logger } = capturingLogger();
  const result = await runRecallPipeline({
    agentId: "agent-a", query, dbTable: table, embeddings: emb, topN: 10,
    canonicalEnabled: false, associativeEnabled: false, logger, now: NOW, ...extra,
  });
  return { ids: result.memories.map((m) => m.entry.id).sort(), result, lines, table, embedCalls };
}
const temporalLines = (lines) => lines.filter((l) => /temporal/.test(l));

describe("runRecallPipeline: temporalFilterMode", () => {
  const rows = [
    row("y", 0.2, YESTERDAY + 10 * HOUR),
    row("grace", 0.25, TODAY + 1 * HOUR), // Auto-Capture nach Mitternacht
    row("old", 0.1, Date.parse("2026-01-01T10:00:00Z")),
  ];

  it("intent: Gesprächszeit filtert hart, mit 2 h Kulanz; Log ohne Anfragetext", async () => {
    const { ids, lines } = await recall("What did we discuss yesterday about the bridge?", rows);
    assert.deepEqual(ids, ["grace", "y"]);
    const logs = temporalLines(lines);
    assert.deepEqual(logs, ["recall-pipeline: temporal filter applied (3 → 2) kind=yesterday"]);
    assert.ok(!logs.some((l) => /discuss|bridge/i.test(l)));
  });

  it("intent: Ereigniszeit filtert nicht; Log nennt kind, reason, inWindow", async () => {
    const aprRows = [row("apr", 0.3, Date.UTC(2026, 3, 10)), ...rows];
    const { ids, lines } = await recall("What did Audrey eat at the picnic in April 2026?", aprRows);
    assert.deepEqual(ids, ["apr", "grace", "old", "y"]);
    assert.deepEqual(temporalLines(lines), [
      "recall-pipeline: temporal phrase not used as filter (kind=monthYear, reason=absolute-time, inWindow 1/4)",
    ]);
  });

  it("intent: kein Gesprächsbezug -> kein Filter", async () => {
    const { ids, lines } = await recall("Was war gestern?", rows);
    assert.deepEqual(ids, ["grace", "old", "y"]);
    assert.deepEqual(temporalLines(lines), [
      "recall-pipeline: temporal phrase not used as filter (kind=yesterday, reason=no-conversation-cue, inWindow 1/3)",
    ]);
  });

  it("intent: Anker ruft temporalRangeFromAnchor nicht auf (kein Embedding, kein zweiter vectorSearch)", async () => {
    const { ids, lines, table, embedCalls } = await recall("what happened after the docker setup", rows);
    assert.deepEqual(ids, ["grace", "old", "y"]);
    assert.equal(table.calls.vectorSearch, 1);
    assert.deepEqual(embedCalls, []);
    const logs = temporalLines(lines);
    assert.deepEqual(logs, ["recall-pipeline: temporal phrase not used as filter (kind=anchor, reason=anchor)"]);
    assert.ok(!logs.some((l) => /docker/i.test(l)));
  });

  it("intent: würde der Filter alles entfernen, bleibt alles (7.12.41)", async () => {
    const { ids, lines } = await recall("Was hast du mir vor 3 Tagen gesagt?", rows);
    assert.deepEqual(ids, ["grace", "old", "y"]);
    assert.deepEqual(temporalLines(lines), [
      "recall-pipeline: temporal filter would remove all 3 results — kept unfiltered kind=daysAgo",
    ]);
  });

  it("intent ist der Default; unbekannte Modi gelten als intent", async () => {
    const a = await recall("Was war gestern?", rows, { temporalFilterMode: "intent" });
    const b = await recall("Was war gestern?", rows, { temporalFilterMode: "bogus" });
    const c = await recall("Was war gestern?", rows);
    assert.deepEqual(a.lines, c.lines);
    assert.deepEqual(b.lines, c.lines);
  });

  it("intent: harter Filter schreibt Trace-Entscheidungen wie bisher", async () => {
    const { result } = await recall("what did I tell you yesterday", rows, { decisionTrace: true });
    const rejected = result.trace.decisions.filter((d) => d.stage === "temporal-filter");
    assert.deepEqual(rejected.map((d) => [d.memoryId, d.action, d.reason]), [["old", "rejection", "outside temporal range"]]);
  });

  it("legacy: reproduziert 7.20.7 (Monatsfenster hart, Anker über Embedding)", async () => {
    const aprRows = [row("apr", 0.3, Date.UTC(2026, 3, 10)), ...rows];
    const month = await recall("What did Audrey eat at the picnic in April 2026?", aprRows, { temporalFilterMode: "legacy" });
    assert.deepEqual(month.ids, ["apr"]);
    assert.deepEqual(temporalLines(month.lines), ["recall-pipeline: temporal filter applied (4 → 1)"]);

    const plainYesterday = await recall("Was war gestern?", rows, { temporalFilterMode: "legacy" });
    assert.deepEqual(plainYesterday.ids, ["y"], "7.20.7 kannte weder Gesprächsbezug noch Kulanz");

    const anchor = await recall("what happened after the docker setup", rows, { temporalFilterMode: "legacy" });
    assert.deepEqual(anchor.embedCalls, ["docker setup"]);
    assert.equal(anchor.table.calls.vectorSearch, 2);
  });

  it("off: kein Parser, kein Filter, kein Log", async () => {
    const { ids, lines } = await recall("What did we discuss yesterday?", rows, { temporalFilterMode: "off" });
    assert.deepEqual(ids, ["grace", "old", "y"]);
    assert.deepEqual(temporalLines(lines), []);
  });

  it("validAt schaltet den Zeitfilter in jedem Modus ab (Bi-Temporal-Invariante)", async () => {
    for (const temporalFilterMode of ["intent", "legacy"]) {
      const { ids, lines } = await recall("What did we discuss yesterday?", rows, { temporalFilterMode, validAt: NOW });
      assert.deepEqual(ids, ["grace", "old", "y"], temporalFilterMode);
      assert.deepEqual(temporalLines(lines), [], temporalFilterMode);
    }
  });
});
