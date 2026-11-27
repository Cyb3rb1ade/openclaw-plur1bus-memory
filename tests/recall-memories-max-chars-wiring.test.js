import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { formatRelevantMemoriesContext } from "../lib/relevant-memory-context.js";
import { readRuntimeSources } from "./helpers/runtime-sources.js";

// engine/recall/assemble-prompt-context.js reicht den Wert durch (bis 7.16.9
// tat das der Recall-Hook in index.js). Ohne diese Stelle bliebe
// recall.memoriesMaxChars wirkungslos.
describe("recall.memoriesMaxChars", () => {
  it("wird im Recall als maxTotalChars an formatRelevantMemoriesContext gereicht", () => {
    const source = readRuntimeSources().engine.assemblePromptContext;
    const call = source.slice(source.indexOf("const memoriesContext = formatRelevantMemoriesContext(promptItems, {"));
    assert.match(call.slice(0, 600), /maxTotalChars: recallCfg\.memoriesMaxChars \?\? 12_000/);
  });

  it("steht im Konfigurationsschema", () => {
    const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
    assert.ok(JSON.stringify(manifest.configSchema).includes('"memoriesMaxChars"'));
  });

  it("kürzt mit kleinem Cap an einer Record-Grenze und schließt den Wrapper", () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      text: `Erinnerung Nummer ${i} mit etwas Text, damit der Block groß genug wird.`,
      category: "fact",
      score: 0.9,
    }));
    const out = formatRelevantMemoriesContext(items, { maxTotalChars: 1200 });
    assert.ok(out.length <= 1200 + 200, `zu lang: ${out.length}`);
    assert.equal((out.match(/<!-- memory context truncated -->/g) || []).length, 1);
    assert.equal((out.match(/<memory-record\b/g) || []).length, (out.match(/<\/memory-record>/g) || []).length);
    assert.match(out.trimEnd(), /<\/relevant-memories>$/);
  });
});
