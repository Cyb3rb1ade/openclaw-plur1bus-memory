// tests/recall-temporal-provenance-gaps.test.js
// Regressionstests für die drei Mapping-Lücken, die im Prompt dauerhaft
// age="unknown" / freshness="unknown" erzeugt haben:
//   A) Canonical-Hits (KNOWLEDGE.md) trugen nie einen Zeitstempel
//   B) Semantic-Lens-Hits verloren createdAt im Mapping
//   C) Reactivation-Records renderten age/freshness gar nicht
// Siehe docs/superpowers/specs/2026-08-11-recall-temporal-provenance-gaps-design.md

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatRelevantMemoriesContext } from "../lib/relevant-memory-context.js";
import {
  buildTemporalProvenance,
  parseMemoryTimestamp,
  shouldRequireLiveVerification,
} from "../lib/temporal-provenance.js";
import { knowledgeMtimeMs, searchCanonical } from "../lib/recall-pipeline.js";
import { formatReactivationContext } from "../lib/conversation-reactivation-recall.js";

const NOW_ISO = "2026-08-11T12:00:00.000Z";
const NOW_MS = new Date(NOW_ISO).getTime();
const ONE_HOUR_AGO = new Date(NOW_MS - 60 * 60 * 1000).toISOString();

describe("Lücke A — Canonical-Hits tragen die KNOWLEDGE.md-mtime", () => {
  it("knowledgeMtimeMs liefert die mtime der Datei", () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-knowledge-"));
    try {
      mkdirSync(join(dir, "memory"), { recursive: true });
      const file = join(dir, "memory", "KNOWLEDGE.md");
      writeFileSync(file, "## OpenClaw\nGateway läuft als systemd-Service.\n", "utf8");
      const expected = new Date("2026-07-01T16:49:00.000Z");
      utimesSync(file, expected, expected);

      assert.equal(knowledgeMtimeMs(dir), expected.getTime());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("knowledgeMtimeMs liefert 0 bei fehlender Datei oder fehlendem Workspace", () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-knowledge-empty-"));
    try {
      assert.equal(knowledgeMtimeMs(dir), 0);
      assert.equal(knowledgeMtimeMs(""), 0);
      assert.equal(knowledgeMtimeMs(undefined), 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("searchCanonical liefert mtimeMs auf jedem Treffer", async () => {
    // Sichert den Feldnamen-Vertrag zwischen searchCanonical und dem
    // Canonical-Mapping in index.js ab. Ohne diesen Test würde ein Tippfehler
    // (c.mtime statt c.mtimeMs) von allen anderen Tests unbemerkt bleiben.
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-canonical-"));
    try {
      mkdirSync(join(dir, "memory"), { recursive: true });
      const file = join(dir, "memory", "KNOWLEDGE.md");
      writeFileSync(
        file,
        "## OpenClaw\nDer Gateway läuft als systemd-Service und wird per Cron überwacht.\n",
        "utf8",
      );
      const stamp = new Date("2026-07-01T16:49:00.000Z");
      utimesSync(file, stamp, stamp);

      // Konstanter Vektor → Cosine-Similarity 1.0 gegen sich selbst.
      const embeddings = { dim: 3, embed: async () => [1, 0, 0] };
      const hits = await searchCanonical(dir, [1, 0, 0], embeddings, 0.3, 5);

      assert.ok(hits.length > 0, "erwartete mindestens einen Canonical-Treffer");
      for (const hit of hits) {
        assert.equal(hit.mtimeMs, stamp.getTime(), "mtimeMs muss die Datei-mtime tragen");
        assert.equal(hit.mtimeMs, knowledgeMtimeMs(dir), "mtimeMs muss knowledgeMtimeMs entsprechen");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Canonical-Item rendert echtes Alter statt unknown", () => {
    // Nachbau des Items aus index.js (Canonical-Schleife).
    const canonicalItem = {
      id: "canonical:OpenClaw",
      category: "canonical",
      source: "knowledge",
      display: "OpenClaw — Gateway läuft als systemd-Service, Cron via openclaw cron.",
      createdAt: new Date("2026-07-01T16:49:00.000Z").getTime(),
      authoritative: true,
    };
    const out = formatRelevantMemoriesContext([canonicalItem], { now: NOW_MS });

    assert.ok(!out.includes('age="unknown"'), `age sollte nicht unknown sein: ${out}`);
    assert.ok(!out.includes('freshness="unknown"'), `freshness sollte nicht unknown sein: ${out}`);
    assert.ok(out.includes('age="41d ago"'), `erwartetes Alter fehlt in: ${out}`);
    assert.ok(out.includes('created-at="2026-07-01T16:49:00.000Z"'), `created-at fehlt in: ${out}`);
  });

  it("Canonical-Item wird als autoritativ markiert und nicht zur Live-Prüfung gezwungen", () => {
    const canonicalItem = {
      id: "canonical:OpenClaw",
      category: "canonical",
      source: "knowledge",
      // Operational-Keywords (cron/gateway/deploy) lösten bisher den Guard aus.
      display: "OpenClaw — Cron und Gateway, deploy script unter /root/.openclaw.",
      createdAt: new Date("2026-07-01T16:49:00.000Z").getTime(),
      authoritative: true,
    };
    const out = formatRelevantMemoriesContext([canonicalItem], { now: NOW_MS });

    assert.ok(out.includes('operational="true"'), `operational sollte erkannt bleiben: ${out}`);
    assert.ok(out.includes('authoritative="true"'), `authoritative fehlt in: ${out}`);
    assert.ok(
      !out.includes('requires-live-verification="true"'),
      `autoritative Quelle darf keine Live-Verifikation verlangen: ${out}`,
    );
  });

  it("nicht-autoritative operative Memories behalten den Guard", () => {
    const out = formatRelevantMemoriesContext([{
      id: "m1",
      category: "fact",
      source: "dm",
      display: "Cronjob für den Gateway deploy erzeugt Duplikate",
      createdAt: new Date("2026-07-01T16:49:00.000Z").getTime(),
    }], { now: NOW_MS });

    assert.ok(
      out.includes('requires-live-verification="true"'),
      `Guard muss ohne authoritative weiter greifen: ${out}`,
    );
    assert.ok(!out.includes('authoritative="true"'), `authoritative darf nicht gesetzt sein: ${out}`);
  });

  it("shouldRequireLiveVerification unterdrückt den Guard nur für autoritative Quellen", () => {
    for (const freshness of ["stale", "unknown"]) {
      assert.equal(
        shouldRequireLiveVerification({ isOperational: true, freshness, authoritative: true }),
        false,
        `authoritative sollte bei freshness=${freshness} unterdrücken`,
      );
      assert.equal(
        shouldRequireLiveVerification({ isOperational: true, freshness }),
        true,
        `ohne authoritative muss der Guard bei freshness=${freshness} greifen`,
      );
    }
  });

  it("buildTemporalProvenance übernimmt das authoritative-Flag", () => {
    const withFlag = buildTemporalProvenance(
      { text: "cron deploy", createdAt: NOW_MS - 1000, authoritative: true },
      { now: NOW_MS },
    );
    assert.equal(withFlag.authoritative, true);

    const withoutFlag = buildTemporalProvenance(
      { text: "cron deploy", createdAt: NOW_MS - 1000 },
      { now: NOW_MS },
    );
    assert.equal(withoutFlag.authoritative, false);
  });

  it("fehlende KNOWLEDGE.md fällt sauber auf das bisherige Verhalten zurück", () => {
    // knowledgeMtimeMs → 0 → createdAt: 0 → parseMemoryTimestamp(0) === undefined
    const out = formatRelevantMemoriesContext([{
      id: "canonical:OpenClaw",
      category: "canonical",
      source: "knowledge",
      display: "OpenClaw — irgendein Inhalt ohne Zeitbezug.",
      createdAt: 0,
      authoritative: true,
    }], { now: NOW_MS });

    assert.ok(out.includes('age="unknown"'), `Fallback auf unknown erwartet: ${out}`);
    assert.ok(!out.includes("created-at="), `created-at darf ohne Zeitstempel fehlen: ${out}`);
  });
});

describe("Härtung — entartete Zeitstempel reißen das Rendering nicht ab", () => {
  // Vorbestehender Defekt, der durch die zusätzlichen Quellen (Reactivation,
  // Lens) erreichbar wurde: new Date(1e18).toISOString() wirft RangeError und
  // hätte das komplette Recall-Rendering abgebrochen.
  const DEGENERATE = [0, -1, -1e15, 1e18, Number.MAX_SAFE_INTEGER, NaN,
    Infinity, -Infinity, "kein-datum", "", null, undefined, {}, [], true];

  it("parseMemoryTimestamp weist Werte außerhalb des Date-Bereichs zurück", () => {
    assert.equal(parseMemoryTimestamp(1e18), undefined);
    assert.equal(parseMemoryTimestamp(-1e18), undefined);
    assert.equal(parseMemoryTimestamp(8_640_000_000_000_001), undefined);
    assert.equal(parseMemoryTimestamp(-8_640_000_000_000_001), undefined);
    // Der gültige Rand bleibt erhalten — auch negative Werte innerhalb des
    // darstellbaren Bereichs sind legitime (wenn auch absurd alte) Daten.
    assert.equal(parseMemoryTimestamp(8_640_000_000_000_000), 8_640_000_000_000_000);
    assert.equal(parseMemoryTimestamp(-1e15), -1e15);
    assert.equal(parseMemoryTimestamp(NOW_MS), NOW_MS);
  });

  it("buildTemporalProvenance wirft bei keinem entarteten Wert", () => {
    for (const createdAt of DEGENERATE) {
      assert.doesNotThrow(
        () => buildTemporalProvenance({ createdAt, text: "cron deploy" }, { now: NOW_MS }),
        `createdAt=${JSON.stringify(createdAt)} darf nicht werfen`,
      );
    }
  });

  it("ageLabel bleibt auf ein sicheres Format beschränkt", () => {
    // Belegt, dass das age-Attribut auch im untrusted Reactivation-Block
    // keine fremden Zeichen in den Prompt tragen kann.
    const SAFE = /^(unknown|\d+[mhd] ago)$/;
    for (const createdAt of [...DEGENERATE, "<script>x</script>", '" onload="x']) {
      const { ageLabel } = buildTemporalProvenance({ createdAt, text: "x" }, { now: NOW_MS });
      assert.match(ageLabel, SAFE, `unerwartetes ageLabel für ${JSON.stringify(createdAt)}`);
    }
  });
});

describe("Lücke B — Semantic-Lens-Hits behalten ihren Zeitstempel", () => {
  it("Lens-Memory rendert echtes Alter statt unknown", () => {
    // Der Formatter bricht bei leerer memories-Liste früh ab, deshalb ein
    // regulärer Treffer als Träger des Lens-Blocks.
    const out = formatRelevantMemoriesContext([{
      id: "m1",
      category: "fact",
      source: "dm",
      display: "Regulärer Vektor-Treffer",
      createdAt: ONE_HOUR_AGO,
    }], {
      now: NOW_MS,
      semanticLensMemories: [{
        id: "lens1",
        category: "fact",
        source: "semantic-lens",
        display: "Ein per Lens gefundener Eintrag",
        createdAt: ONE_HOUR_AGO,
      }],
    });

    assert.ok(out.includes('age="1h ago"'), `erwartetes Alter fehlt in: ${out}`);
    assert.ok(out.includes('freshness="recent"'), `erwartete freshness fehlt in: ${out}`);
    assert.ok(!out.includes('age="unknown"'), `age darf nicht unknown sein: ${out}`);
  });
});

describe("Lücke C — Reactivation-Records rendern Alter", () => {
  it("Reactivation-Block enthält age/freshness", () => {
    const out = formatReactivationContext([{
      id: "r1",
      category: "fact",
      display: "Woran wir zuletzt gearbeitet haben",
      createdAt: ONE_HOUR_AGO,
    }], { now: NOW_MS });

    assert.ok(out.includes('age="1h ago"'), `erwartetes Alter fehlt in: ${out}`);
    assert.ok(out.includes('freshness="recent"'), `erwartete freshness fehlt in: ${out}`);
  });

  it("Reactivation-Record ohne Zeitstempel bleibt renderbar", () => {
    const out = formatReactivationContext([{
      id: "r1",
      category: "fact",
      display: "Eintrag ohne Zeitstempel",
      createdAt: 0,
    }], { now: NOW_MS });

    assert.ok(out.includes('age="unknown"'), `Fallback auf unknown erwartet: ${out}`);
    assert.ok(out.includes("<memory-record"), `Record muss weiterhin gerendert werden: ${out}`);
  });
});
