// Enrichment sidecar (E1): append-only JSONL, newest revision per id across
// the live and backfill files, contentHash invalidation, incremental and
// bounded reading, and the in-memory indexes of the retrieval arms.
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  ENRICH_DIR_NAME,
  ENRICH_REFRESH_MAX_BYTES,
  appendAgentEnrichmentEntries,
  appendEnrichmentEntriesToFile,
  createEnrichmentIndex,
  drainEnrichmentIndex,
  enrichmentSidecarPaths,
  isEntryFresh,
  loadEnrichmentIndex,
  projectEnrichmentEntry,
  resetEnrichmentIndexes,
} from "../lib/enrichment/sidecar.js";
import { enrichmentContentHash } from "../lib/enrichment/enrich-llm.js";
import { dayRangeToMs } from "../lib/enrichment/date-resolver.js";
import { makeTempDir } from "./helpers/temp-dir.js";

afterEach(() => resetEnrichmentIndexes());

function event(from, until, over = {}) {
  const ms = dayRangeToMs(from, until, "UTC");
  return { from, until, fromMs: ms.fromMs, untilMs: ms.untilMs, precision: from === until ? "day" : "range", kind: "past", phrase: "yesterday", source: "relative", ...over };
}

function entry(id, over = {}) {
  return {
    id,
    contentHash: enrichmentContentHash(over.text ?? `text ${id}`),
    enrichedAt: 1_000,
    enrichVersion: 1,
    model: "m",
    promptHash: "p",
    timeZone: "UTC",
    anchorTs: 5,
    entities: [],
    about: [],
    facets: [],
    event: null,
    dateCheck: "none",
    ...over,
  };
}

const lines = (file) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

describe("enrichment sidecar paths and writes", () => {
  it("places the files below the agent directory and rejects unsafe agent ids", () => {
    const base = makeTempDir("plur1bus-enrich-paths-");
    const paths = enrichmentSidecarPaths(base, "main");
    assert.ok(paths.live.endsWith(join("main", ENRICH_DIR_NAME, "enrichment.jsonl")));
    assert.ok(paths.backfill.endsWith(join("main", ENRICH_DIR_NAME, "enrichment.backfill.jsonl")));
    assert.throws(() => enrichmentSidecarPaths(base, "../evil"));
    assert.throws(() => enrichmentSidecarPaths(base, "a/b"));
  });

  it("the production writer resolves the agent's file and refuses unsafe ids and unknown writers", () => {
    const base = makeTempDir("plur1bus-enrich-agent-write-");
    const out = appendAgentEnrichmentEntries(base, "main", "backfill", [entry("a")]);
    assert.equal(out.written, 1);
    assert.deepEqual(lines(enrichmentSidecarPaths(base, "main").backfill).map((e) => e.id), ["a"]);
    assert.throws(() => appendAgentEnrichmentEntries(base, "../evil", "live", [entry("b")]));
    assert.throws(() => appendAgentEnrichmentEntries(base, "main", "../../x", [entry("b")]), TypeError);
  });

  it("writes only valid entries, projected to the fixed field list", () => {
    const base = makeTempDir("plur1bus-enrich-write-");
    const { live } = enrichmentSidecarPaths(base, "main");
    const out = appendEnrichmentEntriesToFile(live, [
      entry("a", { validFrom: 1, validUntil: 2, text: "secret text", note: "x" }),
      entry("b", { facets: ["gardening"] }),
      entry("c", { event: event("2026-05-07", "2026-05-07"), dateCheck: "agree" }),
    ]);
    assert.equal(out.written, 2);
    assert.deepEqual(out.invalid, [{ id: "b", error: "facets" }]);
    const written = lines(live);
    assert.deepEqual(written.map((e) => e.id), ["a", "c"]);
    for (const e of written) {
      for (const banned of ["validFrom", "validUntil", "text", "note"]) assert.equal(banned in e, false, banned);
    }
    if (process.platform !== "win32") {
      assert.equal(statSync(live).mode & 0o777, 0o600);
      assert.equal(statSync(join(base, "main", ENRICH_DIR_NAME)).mode & 0o777, 0o700);
    }
  });

  it("validates events and names on projection", () => {
    assert.equal(projectEnrichmentEntry(entry("a", { event: { ...event("2026-05-07", "2026-05-07"), untilMs: 0 } })).ok, false);
    assert.equal(projectEnrichmentEntry(entry("a", { entities: [7] })).ok, false);
    assert.equal(projectEnrichmentEntry(entry("a", { contentHash: "nothex" })).ok, false);
    assert.equal(projectEnrichmentEntry(entry("a", { dateCheck: "maybe" })).ok, false);
    assert.equal(projectEnrichmentEntry(entry("a\nb")).ok, false);
    assert.deepEqual(projectEnrichmentEntry(entry("a", { entities: [" Melanie ", "melanie"] })).entry.entities, ["melanie"]);
  });
});

describe("enrichment sidecar loading", () => {
  function setup() {
    const base = makeTempDir("plur1bus-enrich-load-");
    return enrichmentSidecarPaths(base, "main");
  }

  it("keeps the newest enrichedAt per id across both files, ties to the later file", () => {
    const { live, backfill } = setup();
    appendEnrichmentEntriesToFile(backfill, [entry("a", { enrichedAt: 3_000, entities: ["old"] }), entry("b", { enrichedAt: 1_000, entities: ["backfill"] }), entry("t", { enrichedAt: 1_000, entities: ["first"] })]);
    appendEnrichmentEntriesToFile(live, [entry("a", { enrichedAt: 2_000, entities: ["live"] }), entry("b", { enrichedAt: 2_000, entities: ["live"] }), entry("t", { enrichedAt: 1_000, entities: ["second"] })]);
    const { index, complete } = loadEnrichmentIndex([backfill, live]);
    assert.equal(complete, true);
    assert.deepEqual(index.get("a").entities, ["old"]);
    assert.deepEqual(index.get("b").entities, ["live"]);
    assert.deepEqual(index.get("t").entities, ["second"]);
    assert.deepEqual(index.idsForEntity("old"), ["a"]);
    assert.deepEqual(index.idsForEntity("backfill"), []);
  });

  it("reads only appended lines and rebuilds after a rewrite", () => {
    const { live } = setup();
    appendEnrichmentEntriesToFile(live, [entry("a", { entities: ["x"] }), entry("b")]);
    const first = loadEnrichmentIndex([live]);
    assert.equal(first.stats.lines, 2);
    appendEnrichmentEntriesToFile(live, [entry("a", { enrichedAt: 2_000, entities: ["y"] })]);
    const second = loadEnrichmentIndex([live]);
    assert.equal(second.stats.lines, 3);
    assert.equal(second.stats.rebuilds, 0);
    assert.deepEqual(second.index.idsForEntity("x"), []);
    assert.deepEqual(second.index.idsForEntity("y"), ["a"]);

    const tmp = `${live}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(entry("c"))}\n`);
    renameSync(tmp, live);
    const third = loadEnrichmentIndex([live]);
    assert.equal(third.stats.rebuilds, 1);
    assert.deepEqual(third.index.ids(), ["c"]);
  });

  it("skips broken lines and waits for a half-written last line", () => {
    const { live } = setup();
    appendEnrichmentEntriesToFile(live, [entry("a")]);
    appendFileSync(live, "{not json\n");
    appendFileSync(live, `${JSON.stringify({ ...entry("bad"), enrichVersion: 0 })}\n`);
    appendFileSync(live, JSON.stringify(entry("late")).slice(0, 20));
    const first = loadEnrichmentIndex([live]);
    assert.deepEqual(first.index.ids(), ["a"]);
    assert.equal(first.stats.parseErrors, 1);
    assert.equal(first.stats.invalid, 1);
    appendFileSync(live, `${JSON.stringify(entry("late")).slice(20)}\n`);
    const second = loadEnrichmentIndex([live]);
    assert.deepEqual(second.index.ids().sort(), ["a", "late"]);
  });

  it("bounds the bytes read per refresh and still passes a line longer than the budget", () => {
    const { live } = setup();
    appendEnrichmentEntriesToFile(live, Array.from({ length: 20 }, (_, i) => entry(`id-${i}`)));
    let result = loadEnrichmentIndex([live], { maxBytesPerRefresh: 600 });
    assert.equal(result.complete, false);
    let calls = 1;
    while (!result.complete && calls < 100) { result = loadEnrichmentIndex([live], { maxBytesPerRefresh: 600 }); calls++; }
    assert.equal(result.complete, true);
    assert.ok(calls > 2);
    assert.equal(result.index.size, 20);

    resetEnrichmentIndexes();
    const tiny = loadEnrichmentIndex([live], { maxBytesPerRefresh: 10 });
    assert.equal(tiny.complete, false);
    assert.ok(tiny.index.size >= 1 && tiny.index.size < 20, `read ${tiny.index.size} entries`);
  });

  it("keeps one synchronous refresh small (at most 256 KB)", () => {
    assert.ok(ENRICH_REFRESH_MAX_BYTES <= 256 * 1024);
  });

  it("drains the rest of a partly read sidecar off the caller, one refresh per turn", async () => {
    const { live, backfill } = setup();
    appendEnrichmentEntriesToFile(backfill, Array.from({ length: 30 }, (_, i) => entry(`b-${i}`)));
    appendEnrichmentEntriesToFile(live, Array.from({ length: 30 }, (_, i) => entry(`l-${i}`)));
    const opts = { maxBytesPerRefresh: 700 };
    const first = loadEnrichmentIndex([backfill, live], opts);
    assert.equal(first.complete, false);
    const drain = drainEnrichmentIndex([backfill, live], opts);
    assert.equal(drainEnrichmentIndex([backfill, live], opts), drain, "one drain per file list");
    assert.equal(first.index.size < 60, true, "nothing more was read synchronously");
    const done = await drain;
    assert.equal(done.complete, true);
    assert.ok(done.rounds > 2);
    const after = loadEnrichmentIndex([backfill, live], opts);
    assert.equal(after.complete, true);
    assert.equal(after.index.size, 60);
    assert.notEqual(drainEnrichmentIndex([backfill, live], opts), drain, "a finished drain is not reused");
  });

  it("a drain stops after resetEnrichmentIndexes and at its round limit", async () => {
    const { live } = setup();
    appendEnrichmentEntriesToFile(live, Array.from({ length: 30 }, (_, i) => entry(`id-${i}`)));
    const drain = drainEnrichmentIndex([live], { maxBytesPerRefresh: 200 });
    resetEnrichmentIndexes();
    assert.equal((await drain).stopped, "reset");
    const capped = await drainEnrichmentIndex([live], { maxBytesPerRefresh: 200, maxRounds: 2 });
    assert.deepEqual([capped.complete, capped.stopped, capped.rounds], [false, "max-rounds", 2]);
  });

  it("filters entries below a minimum enrich version and tolerates missing files", () => {
    const { live, backfill } = setup();
    appendEnrichmentEntriesToFile(live, [entry("a", { enrichVersion: 1 }), entry("b", { enrichVersion: 2 })]);
    const { index, stats, complete } = loadEnrichmentIndex([backfill, live], { minEnrichVersion: 2 });
    assert.deepEqual(index.ids(), ["b"]);
    assert.equal(stats.oldVersion, 1);
    assert.equal(complete, true);
  });
});

describe("enrichment index", () => {
  it("invalidates entries whose content hash no longer matches the text", () => {
    const index = createEnrichmentIndex();
    index.offer(projectEnrichmentEntry(entry("a", { text: "I went camping." })).entry);
    assert.ok(index.lookup("a", "I went camping."));
    assert.equal(index.lookup("a", "I went camping!"), null);
    assert.equal(isEntryFresh(index.get("a"), "I went camping."), true);
    assert.equal(isEntryFresh(null, "x"), false);
  });

  it("indexes entities, persons, facets, person+facet and event intervals", () => {
    const index = createEnrichmentIndex();
    const add = (e) => index.offer(projectEnrichmentEntry(e).entry);
    add(entry("a", { entities: ["Pottery class"], about: ["melanie"], facets: ["hobby", "art"], event: event("2026-05-07", "2026-05-07") }));
    add(entry("b", { entities: ["pottery class", "paris"], about: ["caroline"], facets: ["travel"], event: event("2026-04-27", "2026-05-03", { precision: "week" }) }));
    add(entry("c", { entities: [], about: ["melanie"], facets: ["sport"] }));
    assert.deepEqual(index.idsForEntity(" POTTERY class ").sort(), ["a", "b"]);
    assert.deepEqual(index.idsAbout("Melanie").sort(), ["a", "c"]);
    assert.deepEqual(index.idsForFacet("art"), ["a"]);
    assert.deepEqual(index.idsAboutFacet("melanie", "hobby"), ["a"]);
    assert.deepEqual(index.idsAboutFacet("caroline", "hobby"), []);
    assert.deepEqual(index.idsWithEvent().sort(), ["a", "b"]);

    const day = (s) => Date.UTC(...s.split("-").map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))));
    assert.deepEqual(index.eventsOverlapping(day("2026-05-07"), day("2026-05-08")), ["a"]);
    assert.deepEqual(index.eventsOverlapping(day("2026-05-04"), day("2026-05-07")), [], "end exclusive on both sides");
    assert.deepEqual(index.eventsOverlapping(day("2026-05-01"), day("2026-05-08")).sort(), ["a", "b"]);
    assert.deepEqual(index.eventsOverlapping(5, 5), []);

    assert.equal(index.entityDocFreq("pottery class"), 2);
    assert.deepEqual([...index.hubEntities({ ratio: 0.5, minDocs: 1 })], ["pottery class"]);
    assert.deepEqual([...index.hubPersons({ ratio: 0.5, minDocs: 1 })], ["melanie"]);
    assert.deepEqual(index.vocabulary().persons.sort(), ["caroline", "melanie"]);

    // A newer revision replaces the old one in every index.
    add(entry("a", { enrichedAt: 9_000, entities: ["clay"], about: ["melanie"], facets: ["art"] }));
    assert.deepEqual(index.idsForEntity("pottery class"), ["b"]);
    assert.deepEqual(index.idsForEntity("clay"), ["a"]);
    assert.deepEqual(index.idsAboutFacet("melanie", "hobby"), []);
    assert.deepEqual(index.idsWithEvent(), ["b"]);
    assert.deepEqual(index.eventsOverlapping(day("2026-05-07"), day("2026-05-08")), []);
    // An older revision does not.
    assert.equal(add(entry("a", { enrichedAt: 1, entities: ["stale"] })), false);
    assert.deepEqual(index.idsForEntity("stale"), []);
  });

  it("loads a bench sidecar outside any agent directory", () => {
    const dir = makeTempDir("plur1bus-enrich-bench-");
    mkdirSync(join(dir, "tag"));
    const file = join(dir, "tag", "conv-44.jsonl");
    appendEnrichmentEntriesToFile(file, [entry("conv-44:D1:1", { entities: ["melanie"] })]);
    assert.deepEqual(loadEnrichmentIndex([file]).index.idsForEntity("melanie"), ["conv-44:D1:1"]);
  });
});
