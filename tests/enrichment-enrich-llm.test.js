// Prompt, schema and fail-closed parser of the shared enrichment (E1), and
// the cross-check of the model's event date against the resolver.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DATE_CHECKS,
  ENRICH_FACETS,
  ENRICH_VERSION,
  ENRICHMENT_JSON_SCHEMA,
  buildEnrichmentEntries,
  buildEnrichmentPrompt,
  crossCheckEvent,
  enrichBatch,
  enrichmentContentHash,
  enrichmentPromptHash,
  normalizeEnrichmentName,
  parseEnrichmentResponse,
} from "../lib/enrichment/enrich-llm.js";
import { resolveEventDates } from "../lib/enrichment/date-resolver.js";

const ANCHOR = Date.UTC(2026, 4, 8, 13, 56); // Friday
const UTC = "UTC";

const records = [
  { id: "conv-44:D1:1", text: "[2026-05-08 13:56] Caroline: I went to a LGBTQ support group yesterday." },
  { id: "conv-44:D1:2", text: "[2026-05-08 13:56] Melanie: We go camping with the kids every summer." },
];

const item = (key, over = {}) => ({ key, entities: [], about: [], facets: [], event: null, ...over });
const ev = (from, until, over = {}) => ({ from, until, precision: from === until ? "day" : "range", kind: "past", phrase: "yesterday", source: "relative", ...over });

describe("enrichment prompt", () => {
  it("shows the session date with weekday, short keys and texts without the bench stamp", () => {
    const prompt = buildEnrichmentPrompt({ records, anchorMs: ANCHOR, timeZone: UTC });
    assert.deepEqual(prompt.keys, ["1", "2"]);
    assert.equal(prompt.messages.length, 2);
    assert.equal(prompt.messages[0].role, "system");
    const user = prompt.messages[1].content;
    assert.match(user, /^Session date: 2026-05-08 \(Friday\)\nRecords:\n\[1\] Caroline: I went/u);
    assert.doesNotMatch(user, /\[2026-05-08 13:56\]/u);
    assert.equal(prompt.sessionDate, "2026-05-08");
    assert.equal(prompt.schemaName, "memory_enrichment");
    for (const facet of ENRICH_FACETS) assert.ok(prompt.messages[0].content.includes(facet), facet);
  });

  it("computes the session date in the given zone and marks records said on another day", () => {
    const late = Date.UTC(2026, 4, 7, 23, 30);
    const prompt = buildEnrichmentPrompt({
      records: [{ id: "a", text: "Gestern war ich beim Arzt." }, { id: "b", text: "x", anchorMs: Date.UTC(2026, 4, 9, 10) }, { id: "c", text: "y", anchorMs: null }],
      anchorMs: late,
      language: "de",
    });
    assert.equal(prompt.sessionDate, "2026-05-08");
    const user = prompt.messages[1].content;
    assert.match(user, /^Gesprächsdatum: 2026-05-08 \(Freitag\)\nErinnerungen:/u);
    assert.match(user, /\[2\] \(gesagt 2026-05-09\) x/u);
    assert.match(user, /\[3\] \(Datum unbekannt\) y/u);
  });

  it("states an unknown session date and rejects empty or oversized batches", () => {
    const prompt = buildEnrichmentPrompt({ records: [{ id: "a", text: "x" }] });
    assert.match(prompt.messages[1].content, /^Session date: unknown\./u);
    assert.throws(() => buildEnrichmentPrompt({ records: [] }), TypeError);
    assert.throws(() => buildEnrichmentPrompt({ records: Array.from({ length: 41 }, (_, i) => ({ id: String(i), text: "x" })) }), TypeError);
  });

  it("has a stable prompt hash per language", () => {
    assert.match(enrichmentPromptHash("en"), /^[0-9a-f]{16}$/u);
    assert.equal(enrichmentPromptHash("en"), buildEnrichmentPrompt({ records, anchorMs: ANCHOR }).promptHash);
    assert.notEqual(enrichmentPromptHash("en"), enrichmentPromptHash("de"));
  });

  it("uses a strict-mode schema shape (all properties required, no extras) and is frozen", () => {
    const walk = (node, path) => {
      if (!node || typeof node !== "object") return;
      if (node.type === "object") {
        assert.equal(node.additionalProperties, false, path);
        assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort(), path);
      }
      for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
    };
    walk(ENRICHMENT_JSON_SCHEMA, "schema");
    assert.equal(Object.isFrozen(ENRICHMENT_JSON_SCHEMA.properties.records.items.properties.event), true);
  });
});

describe("enrichment parser (fail-closed)", () => {
  const keys = ["1", "2"];

  it("fails the whole batch on invalid JSON or a wrong top-level shape", () => {
    for (const raw of ["not json", "{\"records\": {}}", "[]"]) {
      const out = parseEnrichmentResponse(raw, { keys });
      assert.equal(out.ok, false, raw);
      assert.ok([...out.items.values()].every((i) => i.error), raw);
    }
  });

  it("accepts fenced JSON, normalises names, ignores unknown keys and extra properties", () => {
    const raw = "```json\n" + JSON.stringify({ records: [item("1", { entities: [" Melanie ", "melanie", "New  York"], about: ["Caroline"], facets: ["Hobby"], extra: 1 }), item("9")] }) + "\n```";
    const out = parseEnrichmentResponse(raw, { keys });
    assert.equal(out.ok, true);
    assert.equal(out.unknownKeys, 1);
    assert.deepEqual(out.items.get("1").value, { entities: ["melanie", "new york"], about: ["caroline"], facets: ["hobby"], event: null });
    assert.equal(out.items.get("2").error, "missing");
  });

  it("fails only the record with an invalid field or a duplicated key", () => {
    const cases = [
      [item("1", { facets: ["gardening"] }), "facets-unknown"],
      [item("1", { facets: ["art", "music", "media", "food"] }), "facets-too-many"],
      [item("1", { entities: [42] }), "entities-not-string"],
      [item("1", { entities: ["x".repeat(61)] }), "entities-too-long"],
      [item("1", { event: ev("2026-05-07", "2026-05-08", { precision: "day" }) }), "event-precision-mismatch"],
      [item("1", { event: ev("2026-05-08", "2026-05-07") }), "event-reversed"],
      [item("1", { event: ev("2026-02-30", "2026-02-30") }), "event-bad-date"],
      [item("1", { event: ev("2026-05-07", "2026-05-07", { kind: "maybe" }) }), "event-bad-kind"],
      [{ key: "1", entities: [], about: [], facets: [] }, "event-missing"],
    ];
    for (const [bad, error] of cases) {
      const out = parseEnrichmentResponse({ records: [bad, item("2")] }, { keys });
      assert.equal(out.items.get("1").error, error, JSON.stringify(bad));
      assert.ok(out.items.get("2").value, "other record unaffected");
    }
    const dup = parseEnrichmentResponse({ records: [item("1"), item("1"), item("2")] }, { keys });
    assert.equal(dup.items.get("1").error, "duplicate-key");
    assert.ok(dup.items.get("2").value);
  });

  it("adds epoch bounds (end exclusive) and caps the stored phrase", () => {
    const out = parseEnrichmentResponse({ records: [item("1", { event: ev("2026-05-07", "2026-05-07", { phrase: "y".repeat(100) }) })] }, { keys: ["1"], timeZone: "Europe/Berlin" });
    const event = out.items.get("1").value.event;
    assert.equal(new Date(event.fromMs).toISOString(), "2026-05-06T22:00:00.000Z");
    assert.equal(event.untilMs - event.fromMs, 86_400_000);
    assert.equal(event.phrase.length, 40);
  });
});

describe("enrichment cross-check with the resolver", () => {
  const text = "Caroline: I went to a support group yesterday.";
  const hits = resolveEventDates(text, ANCHOR, { timeZone: UTC });
  const parsedEvent = (from, until, over = {}) => parseEnrichmentResponse({ records: [item("1", { event: ev(from, until, over) })] }, { keys: ["1"], timeZone: UTC }).items.get("1").value.event;

  it("agrees on overlapping days", () => {
    const out = crossCheckEvent(parsedEvent("2026-05-07", "2026-05-07"), hits, { text, anchorMs: ANCHOR });
    assert.equal(out.dateCheck, "agree");
    assert.equal(out.event.from, "2026-05-07");
  });

  it("drops a disagreeing date and keeps the model's candidate", () => {
    const out = crossCheckEvent(parsedEvent("2026-05-06", "2026-05-06"), hits, { text, anchorMs: ANCHOR });
    assert.equal(out.dateCheck, "ambiguous");
    assert.equal(out.event, null);
    assert.equal(out.reason, "phrase-disagrees");
    assert.equal(out.candidate.from, "2026-05-06");
  });

  it("accepts a model date the resolver cannot check (llm-only) and keeps a resolver-only date out (parser-only)", () => {
    const gradText = "We moved after graduation.";
    assert.deepEqual(resolveEventDates(gradText, ANCHOR, { timeZone: UTC }), []);
    const noHits = crossCheckEvent(parsedEvent("2026-04-01", "2026-04-30", { precision: "month", phrase: "after  Graduation" }), [], { text: gradText, anchorMs: ANCHOR });
    assert.equal(noHits.dateCheck, "llm-only");
    assert.ok(noHits.event);
    const parserOnly = crossCheckEvent(null, hits, { text, anchorMs: ANCHOR });
    assert.equal(parserOnly.dateCheck, "parser-only");
    assert.equal(parserOnly.event, null);
    assert.equal(parserOnly.parserEvent.from, "2026-05-07");
    assert.equal(crossCheckEvent(null, [], { text: "x", anchorMs: ANCHOR }).dateCheck, "none");
  });

  it("allows approximate resolver hits a tolerance", () => {
    const fewText = "We met a few days ago.";
    const fewHits = resolveEventDates(fewText, ANCHOR, { timeZone: UTC });
    const out = crossCheckEvent(parsedEvent("2026-05-02", "2026-05-02", { phrase: "a few days ago" }), fewHits, { text: fewText, anchorMs: ANCHOR });
    assert.equal(out.dateCheck, "agree");
  });

  it("separates other phrases from an unverifiable one", () => {
    const two = "We went hiking when it was sunny, see you tomorrow.";
    const twoHits = resolveEventDates(two, ANCHOR, { timeZone: UTC });
    const inText = crossCheckEvent(parsedEvent("2026-04-01", "2026-04-30", { precision: "month", phrase: "when it was sunny" }), twoHits, { text: two, anchorMs: ANCHOR });
    assert.equal(inText.dateCheck, "llm-only");
    const notInText = crossCheckEvent(parsedEvent("2026-04-01", "2026-04-30", { precision: "month", phrase: "in April" }), twoHits, { text: two, anchorMs: ANCHOR });
    assert.equal(notInText.dateCheck, "ambiguous");
    assert.equal(notInText.reason, "unverifiable");
  });

  it("drops a model date whose phrase is not in a text without time words (session-date leak)", () => {
    const anchor = Date.UTC(2023, 4, 8, 13, 56);
    const records = [
      { id: "a", text: "Caroline: I went to the LGBTQ support group and it was so powerful.", anchorMs: anchor },
      { id: "b", text: "Melanie: We are planning a camping trip with the kids.", anchorMs: anchor },
      { id: "c", text: "Melanie: We are planning a camping trip with the kids after graduation.", anchorMs: anchor },
    ];
    for (const r of records) assert.deepEqual(resolveEventDates(r.text, anchor, { timeZone: UTC }), []);
    const raw = {
      records: [
        item("1", { event: ev("2023-05-08", "2023-05-08", { phrase: "today", source: "utterance", kind: "past" }) }),
        item("2", { event: ev("2023-07-01", "2023-07-31", { phrase: "in July", precision: "month", kind: "planned" }) }),
        item("3", { event: ev("2023-07-01", "2023-07-31", { phrase: "after graduation", precision: "month", kind: "planned" }) }),
      ],
    };
    const out = buildEnrichmentEntries({ records, raw, timeZone: UTC, now: 1_770_000_000_000 });
    const [leak, invented, inText] = out.entries;
    for (const entry of [leak, invented]) {
      assert.equal(entry.dateCheck, "ambiguous");
      assert.equal(entry.dateReason, "unverifiable");
      assert.equal(entry.event, null);
      assert.ok(entry.eventCandidate);
    }
    assert.equal(inText.dateCheck, "llm-only");
    assert.equal(inText.event.from, "2023-07-01");
  });

  it("refuses a relative model date without an anchor", () => {
    const out = crossCheckEvent(parsedEvent("2026-05-07", "2026-05-07"), [], { text, anchorMs: null });
    assert.equal(out.dateCheck, "unanchored");
    assert.equal(out.event, null);
  });
});

describe("enrichBatch", () => {
  const answer = {
    records: [
      item("1", { entities: ["LGBTQ support group"], about: ["caroline"], facets: ["identity", "events"], event: ev("2026-05-07", "2026-05-07") }),
      item("2", { entities: [], about: ["melanie"], facets: ["family", "travel"], event: null }),
    ],
  };

  it("passes the schema to complete, returns entries and the provider usage", async () => {
    const calls = [];
    const complete = async (req) => { calls.push(req); return { text: JSON.stringify(answer), usage: { prompt_tokens: 900, completion_tokens: 120 } }; };
    const out = await enrichBatch({ records, complete, anchorMs: ANCHOR, timeZone: UTC, model: "test-model", maxTokens: 1234, now: () => 1_770_000_000_000 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].maxTokens, 1234);
    assert.equal(calls[0].schema, ENRICHMENT_JSON_SCHEMA);
    assert.deepEqual(out.usage, { prompt_tokens: 900, completion_tokens: 120 });
    assert.equal(out.ok, true);
    assert.equal(out.failed.length, 0);
    const [first, second] = out.entries;
    assert.equal(first.id, "conv-44:D1:1");
    assert.equal(first.contentHash, enrichmentContentHash(records[0].text));
    assert.equal(first.enrichVersion, ENRICH_VERSION);
    assert.equal(first.model, "test-model");
    assert.equal(first.promptHash, out.promptHash);
    assert.equal(first.anchorTs, ANCHOR);
    assert.equal(first.enrichedAt, 1_770_000_000_000);
    assert.equal(first.dateCheck, "agree");
    assert.deepEqual(first.entities, ["lgbtq support group"]);
    assert.equal(second.dateCheck, "none");
    assert.ok(DATE_CHECKS.includes(first.dateCheck));
  });

  it("returns a failed batch instead of throwing when complete fails", async () => {
    const out = await enrichBatch({ records, complete: async () => { throw new Error("429 rate limited"); }, anchorMs: ANCHOR, timeZone: UTC });
    assert.equal(out.ok, false);
    assert.match(out.error, /^complete-failed: 429/u);
    assert.equal(out.entries.length, 0);
    assert.deepEqual(out.failed.map((f) => f.id), records.map((r) => r.id));
  });

  it("accepts a plain string answer and re-builds entries from a cached answer", async () => {
    const out = await enrichBatch({ records, complete: async () => JSON.stringify(answer), anchorMs: ANCHOR, timeZone: UTC });
    assert.equal(out.usage, null);
    const again = buildEnrichmentEntries({ records, raw: out.raw, anchorMs: ANCHOR, timeZone: UTC, now: out.entries[0].enrichedAt });
    assert.deepEqual(again.entries.map((e) => ({ ...e, promptHash: "" })), out.entries.map((e) => ({ ...e, promptHash: "" })));
  });

  it("never writes validFrom/validUntil (event time is not real-world validity)", async () => {
    const out = await enrichBatch({ records, complete: async () => JSON.stringify(answer), anchorMs: ANCHOR, timeZone: UTC });
    for (const entry of out.entries) {
      assert.equal("validFrom" in entry, false);
      assert.equal("validUntil" in entry, false);
    }
  });

  it("normalises names for lookups", () => {
    assert.equal(normalizeEnrichmentName("  „Der  Hobbit“. "), "der hobbit");
    assert.equal(normalizeEnrichmentName("..."), "");
  });
});
