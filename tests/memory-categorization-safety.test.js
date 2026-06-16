import { describe, it } from "node:test";
import assert from "node:assert";
import { categorizeMemory, categorizeMemoryWithReason, MEMORY_CATEGORIES } from "../lib/categorize.js";

describe("memory categorization safety", () => {
  it("categorizeMemory returns a valid category", () => {
    const category = categorizeMemory("User prefers concise answers");
    assert.ok(MEMORY_CATEGORIES.includes(category), `${category} should be a valid category`);
  });

  it("categorizeMemoryWithReason returns category and reason", () => {
    const result = categorizeMemoryWithReason("User prefers concise answers");
    assert.ok(MEMORY_CATEGORIES.includes(result.category));
    assert.strictEqual(typeof result.reason, "string");
    assert.ok(result.reason.length > 0);
  });

  it("durable preference is categorized as preference", () => {
    assert.strictEqual(categorizeMemory("User prefers concise answers"), "preference");
    assert.strictEqual(categorizeMemory("I always want German responses"), "preference");
    assert.strictEqual(categorizeMemory("From now on, use German for repo prompts"), "preference");
    assert.strictEqual(categorizeMemory("I never want emojis"), "preference");
  });

  it("project architecture is categorized as decision", () => {
    assert.strictEqual(categorizeMemory("We decided to use React"), "decision");
    assert.strictEqual(categorizeMemory("Deployment läuft auf Node 22"), "decision");
    assert.strictEqual(categorizeMemory("Wir wählen PostgreSQL"), "decision");
  });

  it("correction/update is categorized as decision", () => {
    assert.strictEqual(categorizeMemory("Nicht mehr Vue, jetzt React"), "decision");
    assert.strictEqual(categorizeMemory("No longer Postgres, use MySQL"), "decision");
    assert.strictEqual(categorizeMemory("Instead of REST we now use GraphQL"), "decision");
  });

  it("Dreamdale festival is not miscategorized as fictional place", () => {
    const category = categorizeMemory("Dreamdale ist ein Festival");
    assert.ok(["entity", "fact", "decision"].includes(category), `Dreamdale got ${category}`);
  });

  it("generic technical keywords do not dominate category", () => {
    const category = categorizeMemory("node react postgres");
    assert.strictEqual(category, "conversation", `generic keywords got ${category}`);
  });

  it("filler is categorized as conversation", () => {
    assert.strictEqual(categorizeMemory("ok"), "conversation");
    assert.strictEqual(categorizeMemory("go on!!!!"), "conversation");
  });

  it("temporary status is categorized as conversation", () => {
    assert.strictEqual(categorizeMemory("Today npm test passed"), "conversation");
    assert.strictEqual(categorizeMemory("currently downloading the update"), "conversation");
  });

  it("security/deploy concrete fact is categorized as decision or config", () => {
    const category = categorizeMemory("Auth bypass in group chats was fixed");
    assert.ok(["decision", "config", "debug"].includes(category), `security fact got ${category}`);
  });

  it("named entity fact is categorized as entity or fact", () => {
    const category = categorizeMemory("Dreamdale is a festival");
    assert.ok(["entity", "fact"].includes(category), `named entity fact got ${category}`);
  });

  it("reference/url is categorized as reference", () => {
    assert.strictEqual(categorizeMemory("https://example.com/docs"), "reference");
    assert.strictEqual(categorizeMemory("See the link to the docs"), "reference");
  });

  it("debug/error is categorized as debug", () => {
    assert.strictEqual(categorizeMemory("Stack trace shows null pointer"), "debug");
    assert.strictEqual(categorizeMemory("Fehler beim Deploy"), "debug");
  });

  it("config/setting is categorized as config", () => {
    assert.strictEqual(categorizeMemory("Set the threshold to 0.7"), "config");
    assert.strictEqual(categorizeMemory("Default timeout is 30s"), "config");
  });
});
