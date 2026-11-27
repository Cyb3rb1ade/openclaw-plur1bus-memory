// Deterministic event dates for the shared enrichment (retrieval arms, E1):
// relative phrases in English and German against the time of speaking, civil
// days in a time zone, no date for narrative/recurring/duration phrases.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  civilDayInZone,
  dayRangeToMs,
  parseYmd,
  resolveEventDate,
  resolveEventDates,
  stripLeadingTimestamp,
  zonedDayStartMs,
} from "../lib/enrichment/date-resolver.js";

// Friday 2026-05-08 13:56, bench style (wall clock stored as UTC).
const ANCHOR = Date.UTC(2026, 4, 8, 13, 56);
const UTC = { timeZone: "UTC" };

function one(text, anchor = ANCHOR, opts = UTC) {
  const hits = resolveEventDates(text, anchor, opts);
  assert.equal(hits.length, 1, `expected one hit for ${JSON.stringify(text)}, got ${JSON.stringify(hits.map((h) => h.phrase))}`);
  return hits[0];
}

const span = (h) => `${h.from}..${h.until}`;

describe("enrichment date resolver: English relative phrases", () => {
  it("resolves day words against the anchor day", () => {
    assert.equal(span(one("I went to a support group yesterday.")), "2026-05-07..2026-05-07");
    assert.equal(span(one("We met the day before yesterday.")), "2026-05-06..2026-05-06");
    assert.equal(span(one("See you tomorrow!")), "2026-05-09..2026-05-09");
    const today = one("I'm at the beach right now.");
    assert.equal(span(today), "2026-05-08..2026-05-08");
    assert.equal(today.source, "utterance");
  });

  it("treats last week as the whole previous calendar week (Monday to Sunday)", () => {
    const h = one("We went camping last week.");
    assert.equal(span(h), "2026-04-27..2026-05-03");
    assert.equal(h.precision, "week");
    assert.equal(h.kind, "past");
    assert.equal(span(one("two weeks ago")), "2026-04-20..2026-04-26");
    assert.equal(span(one("next week")), "2026-05-11..2026-05-17");
  });

  it("resolves months, years, weekends and weekdays", () => {
    assert.equal(span(one("I'm going to a concert next month!")), "2026-06-01..2026-06-30");
    assert.equal(span(one("last month")), "2026-04-01..2026-04-30");
    assert.equal(span(one("I painted a sunrise last year.")), "2025-01-01..2025-12-31");
    assert.equal(span(one("last weekend we had a party")), "2026-05-02..2026-05-03");
    assert.equal(span(one("We met last Friday.")), "2026-05-01..2026-05-01");
    assert.equal(span(one("We celebrated on Saturday.")), "2026-05-02..2026-05-02");
  });

  it("marks vague counts as approximate ranges", () => {
    const h = one("a few days ago");
    assert.equal(h.precision, "range");
    assert.equal(h.approximate, true);
    assert.equal(span(h), "2026-05-03..2026-05-06");
  });

  it("reads durations up to now only with a since-cue", () => {
    const h = one("I've been painting for two years now.");
    assert.equal(h.kind, "ongoing");
    assert.equal(span(h), "2024-05-08..2026-05-08");
    assert.deepEqual(resolveEventDates("I went to Paris for two weeks.", ANCHOR, UTC), []);
    assert.deepEqual(resolveEventDates("I finished it in two weeks.", ANCHOR, UTC), []);
    assert.equal(span(one("I'll see you in two weeks")), "2026-05-18..2026-05-24");
  });

  it("resolves explicit dates and ranges", () => {
    assert.equal(span(one("I met her on 3 May 2023")), "2023-05-03..2023-05-03");
    assert.equal(one("I met her on 3 May 2023").source, "explicit");
    assert.equal(span(one("the week of April 3rd to 9th")), "2026-04-03..2026-04-09");
    assert.equal(span(one("the first week of May")), "2026-05-01..2026-05-07");
    assert.equal(span(one("I went there in October")), "2025-10-01..2025-10-31");
    assert.equal(span(one("I'll go there in October")), "2026-10-01..2026-10-31");
    assert.equal(span(one("summer 2024")), "2024-06-01..2024-08-31");
    assert.equal(span(one("since 2020")), "2020-01-01..2026-05-08");
  });
});

describe("enrichment date resolver: German phrases", () => {
  it("resolves vorgestern, gestern, übermorgen", () => {
    assert.equal(span(one("Ich war vorgestern beim Arzt.")), "2026-05-06..2026-05-06");
    assert.equal(span(one("Gestern Abend haben wir gekocht.")), "2026-05-07..2026-05-07");
    assert.equal(span(one("Übermorgen fliegen wir.")), "2026-05-10..2026-05-10");
  });

  it("treats letzte Woche as the whole calendar week and vor zwei Wochen as that week", () => {
    assert.equal(span(one("Letzte Woche war ich krank.")), "2026-04-27..2026-05-03");
    const h = one("Vor zwei Wochen habe ich das Auto gekauft.");
    assert.equal(span(h), "2026-04-20..2026-04-26");
    assert.equal(h.precision, "week");
  });

  it("resolves am 3. Oktober, im Oktober and weekends by tense", () => {
    const planned = one("Am 3. Oktober fahren wir nach Rom.");
    assert.equal(span(planned), "2026-10-03..2026-10-03");
    assert.equal(planned.yearInferred, true);
    assert.equal(span(one("Am 3. Oktober 2025 waren wir in Rom.")), "2025-10-03..2025-10-03");
    assert.equal(span(one("Im Oktober waren wir in Rom.")), "2025-10-01..2025-10-31");
    assert.equal(span(one("Am Wochenende waren wir wandern.")), "2026-05-02..2026-05-03");
    assert.equal(span(one("Letzten Samstag waren wir im Zoo.")), "2026-05-02..2026-05-02");
    assert.equal(span(one("vom 3. bis 5. Oktober")), "2026-10-03..2026-10-05");
  });

  it("reads seit as a duration up to now", () => {
    const h = one("Seit drei Jahren spiele ich Gitarre.");
    assert.equal(h.kind, "ongoing");
    assert.equal(span(h), "2023-05-08..2026-05-08");
  });

  it("separates morgen (tomorrow) from Morgen (morning)", () => {
    const hits = resolveEventDates("Guten Morgen! Morgen gehe ich schwimmen.", ANCHOR, UTC);
    assert.deepEqual(hits.map(span), ["2026-05-09..2026-05-09"]);
    assert.deepEqual(resolveEventDates("Mein Morgen war toll.", ANCHOR, UTC), []);
    assert.equal(span(one("heute Morgen war ich laufen")), "2026-05-08..2026-05-08");
  });
});

describe("enrichment date resolver: German \"was\" is no past cue", () => {
  // Wednesday 2026-11-25 14:00 Europe/Berlin (default zone).
  const WED = Date.UTC(2026, 10, 25, 13, 0);
  const spans = (text) => resolveEventDates(text, WED).map(span);

  it("leaves present-tense weekend and weekday questions without a date", () => {
    assert.deepEqual(spans("Was mache ich am Wochenende?"), []);
    assert.deepEqual(spans("Am Freitag gehe ich zum Arzt, was mich nervt."), []);
  });

  it("puts a date or month without a year at its nearest occurrence", () => {
    assert.deepEqual(spans("Was ist am 3. Januar?"), ["2027-01-03..2027-01-03"]);
    assert.deepEqual(spans("Was hast du im Januar vor?"), ["2027-01-01..2027-01-31"]);
    assert.deepEqual(spans("Eva fragt, was sie im Januar mitbringen soll."), ["2027-01-01..2027-01-31"]);
    assert.deepEqual(spans("Im Januar fliege ich nach Rom."), ["2027-01-01..2027-01-31"]);
  });

  it("still reads German past forms and the perfect tense", () => {
    assert.deepEqual(spans("Was war am Wochenende los?"), ["2026-11-21..2026-11-22"]);
    assert.deepEqual(spans("Am Freitag war ich beim Arzt."), ["2026-11-20..2026-11-20"]);
    assert.deepEqual(spans("Was ist der Unterschied zu dem, was wir im Oktober besprochen haben?"), ["2026-10-01..2026-10-31"]);
  });

  it("keeps English \"was\" and \"-ed\" as past cues", () => {
    assert.deepEqual(spans("It was great on Friday."), ["2026-11-20..2026-11-20"]);
    assert.deepEqual(spans("Was that in January?"), ["2026-01-01..2026-01-31"]);
    assert.deepEqual(spans("We visited them on Friday."), ["2026-11-20..2026-11-20"]);
  });
});

describe("enrichment date resolver: phrases without an anchored date", () => {
  for (const text of [
    "We go hiking every Monday.",
    "Jeden Montag gehe ich schwimmen.",
    "Montags spiele ich Tennis.",
    "The next day we went home.",
    "Am nächsten Tag sind wir heimgefahren.",
    "Two days later it rained.",
    "Ich habe bis heute keine Antwort.",
    "I may go there.",
    "OpenClaw 11.6. ist live, Release 7.21.5. und Version 1.10.12",
    "am 3. Tag",
  ]) {
    it(`no date: ${text}`, () => {
      assert.deepEqual(resolveEventDates(text, ANCHOR, UTC), []);
    });
  }

  it("ignores the leading bench timestamp and image captions; offsets point into the input", () => {
    assert.deepEqual(resolveEventDates("[2026-05-08 13:56] Caroline: Hi there!", ANCHOR, UTC), []);
    const text = "[2026-05-08 13:56] Caroline: I went there yesterday. [shared an image: a photo from 2019]";
    const hits = resolveEventDates(text, ANCHOR, UTC);
    assert.deepEqual(hits.map((h) => h.phrase), ["yesterday"]);
    assert.equal(text.slice(hits[0].index, hits[0].end), "yesterday");
    assert.equal(stripLeadingTimestamp(text).startsWith("Caroline:"), true);
  });

  it("without an anchor resolves only explicit dates with a year", () => {
    const hits = resolveEventDates("gestern, am 3. Oktober 2025 und im Mai", null);
    assert.deepEqual(hits.map((h) => [h.phrase, h.from]), [["am 3. Oktober 2025", "2025-10-03"]]);
  });

  it("returns the first hit or null", () => {
    assert.equal(resolveEventDate("no time here", ANCHOR, UTC), null);
    assert.equal(resolveEventDate("Yesterday I booked a trip for next month.", ANCHOR, UTC).phrase, "Yesterday");
  });
});

describe("enrichment date resolver: time zones", () => {
  it("uses the civil day of the anchor in the zone (Europe/Berlin by default)", () => {
    const late = Date.UTC(2026, 4, 7, 23, 30); // 01:30 on 2026-05-08 in Berlin
    assert.equal(civilDayInZone(late, "UTC"), "2026-05-07");
    assert.equal(civilDayInZone(late), "2026-05-08");
    assert.equal(one("gestern", late, UTC).from, "2026-05-06");
    const berlin = one("gestern", late, {});
    assert.equal(berlin.from, "2026-05-07");
    assert.equal(new Date(berlin.fromMs).toISOString(), "2026-05-06T22:00:00.000Z");
    assert.equal(berlin.untilMs - berlin.fromMs, 86_400_000);
  });

  it("converts day ranges with an exclusive end across a DST change", () => {
    const ms = dayRangeToMs("2026-03-29", "2026-03-29", "Europe/Berlin");
    assert.equal(new Date(ms.fromMs).toISOString(), "2026-03-28T23:00:00.000Z");
    assert.equal(new Date(ms.untilMs).toISOString(), "2026-03-29T22:00:00.000Z");
    assert.equal(zonedDayStartMs("2026-13-01"), null);
    assert.equal(parseYmd("2026-02-30"), null);
    assert.equal(parseYmd("2026-02-28"), Date.UTC(2026, 1, 28));
  });

  it("rejects an invalid zone loudly", () => {
    assert.throws(() => resolveEventDates("yesterday", ANCHOR, { timeZone: "Nowhere/Land" }), RangeError);
  });
});
