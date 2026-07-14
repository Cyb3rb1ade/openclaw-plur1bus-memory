import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectOpenThreads, formatOpenThreadsContext } from "../lib/open-threads.js";

const NOW = 1000 * 86400000; // arbitrary reference point in ms

function entry(topic, outcome, daysAgo) {
  return { topic, outcome, timestamp: NOW - daysAgo * 86400000 };
}

describe("collectOpenThreads", () => {
  it("empty entries → empty result", () => {
    assert.deepEqual(collectOpenThreads([], { now: NOW }), []);
  });

  it("filters correctly by outcome type (only open outcomes)", () => {
    const entries = [
      entry("TopicA", "ignored_or_topic_shifted", 1),
      entry("TopicB", "asked_details", 2),
      entry("TopicC", "something_else", 1),
    ];
    const result = collectOpenThreads(entries, { now: NOW });
    const topics = result.map((r) => r.topic);
    assert.ok(topics.includes("TopicA"), "should include ignored_or_topic_shifted");
    assert.ok(topics.includes("TopicB"), "should include asked_details");
    assert.ok(!topics.includes("TopicC"), "should exclude other outcomes");
  });

  it("excludes topics that have a later resolved entry", () => {
    const entries = [
      entry("TopicA", "ignored_or_topic_shifted", 3),
      entry("TopicA", "confirmed_or_continued", 1), // later → resolves
      entry("TopicB", "asked_details", 2),
    ];
    const result = collectOpenThreads(entries, { now: NOW });
    const topics = result.map((r) => r.topic);
    assert.ok(!topics.includes("TopicA"), "TopicA should be excluded (resolved later)");
    assert.ok(topics.includes("TopicB"), "TopicB should remain open");
  });

  it("does NOT exclude topic if resolved entry is EARLIER than open entry", () => {
    const entries = [
      entry("TopicA", "confirmed_or_continued", 5), // earlier
      entry("TopicA", "ignored_or_topic_shifted", 1), // later open
    ];
    const result = collectOpenThreads(entries, { now: NOW });
    const topics = result.map((r) => r.topic);
    assert.ok(topics.includes("TopicA"), "TopicA open entry is newer than resolved");
  });

  it("respects maxAgeDays", () => {
    const entries = [
      entry("Recent", "ignored_or_topic_shifted", 3),
      entry("TooOld", "ignored_or_topic_shifted", 5),
    ];
    const result = collectOpenThreads(entries, { now: NOW, maxAgeDays: 4 });
    const topics = result.map((r) => r.topic);
    assert.ok(topics.includes("Recent"));
    assert.ok(!topics.includes("TooOld"));
  });

  it("caps at maxResults=2", () => {
    const entries = [
      entry("A", "ignored_or_topic_shifted", 1),
      entry("B", "asked_details", 2),
      entry("C", "ignored_or_topic_shifted", 3),
    ];
    const result = collectOpenThreads(entries, { now: NOW, maxResults: 2 });
    assert.equal(result.length, 2);
  });

  it("returns correct shape {topic, ageDays, hint}", () => {
    const entries = [entry("MyTopic", "asked_details", 2)];
    const result = collectOpenThreads(entries, { now: NOW });
    assert.equal(result.length, 1);
    assert.equal(result[0].topic, "MyTopic");
    assert.equal(result[0].ageDays, 2);
    assert.equal(result[0].hint, "asked_details");
  });

  it("handles null/malformed entries gracefully", () => {
    const entries = [null, undefined, {}, { outcome: "asked_details" }, entry("Good", "asked_details", 1)];
    const result = collectOpenThreads(entries, { now: NOW });
    assert.equal(result.length, 1);
    assert.equal(result[0].topic, "Good");
  });
});

describe("formatOpenThreadsContext", () => {
  it("returns null for empty array", () => {
    assert.equal(formatOpenThreadsContext([]), null);
  });

  it("returns null for undefined/null input", () => {
    assert.equal(formatOpenThreadsContext(null), null);
    assert.equal(formatOpenThreadsContext(undefined), null);
  });

  it("contains 'Offene Fäden' for non-empty threads", () => {
    const threads = [{ topic: "Urlaubsplanung", ageDays: 2, hint: "asked_details" }];
    const result = formatOpenThreadsContext(threads);
    assert.ok(result.includes("Offene Fäden"), "should contain header text");
    assert.ok(result.includes("Urlaubsplanung"));
    assert.ok(result.includes("vor 2 Tag(en)"));
  });

  it("truncates total output to ~400 chars", () => {
    const threads = [
      { topic: "A".repeat(200), ageDays: 1, hint: "asked_details" },
      { topic: "B".repeat(200), ageDays: 2, hint: "ignored_or_topic_shifted" },
    ];
    const result = formatOpenThreadsContext(threads);
    assert.ok(result.length <= 400, `Length ${result.length} should be <= 400`);
  });

  it("returns string with all threads listed", () => {
    const threads = [
      { topic: "Alpha", ageDays: 1, hint: "asked_details" },
      { topic: "Beta", ageDays: 3, hint: "ignored_or_topic_shifted" },
    ];
    const result = formatOpenThreadsContext(threads);
    assert.ok(result.includes("Alpha"));
    assert.ok(result.includes("Beta"));
  });
});
