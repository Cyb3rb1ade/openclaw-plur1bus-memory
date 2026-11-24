// 7.21.1: Rückweg auf 7.21.0. Das Schema von 7.21.0 kennt die neuen Schlüssel
// nicht (additionalProperties false) und lehnt die ganze Plugin-Konfiguration
// ab. Setup und Installer dürfen sie deshalb nicht von selbst schreiben, und
// die Upgrade-Hinweise nennen sie.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { manifestConfigDefaults } from "../lib/setup/config-contract.js";
import { applyFeatureProfile, recommendedProfile, safeProfile } from "../lib/setup/feature-profiles.js";

const NEW_KEYS = [
  ["recall", "keywordFallback"],
  ["recall", "mergeTurnParts"],
  ["recall", "qualityWeighting", "staleAssistant"],
  ["runtime", "recallPrewarm"],
];

function has(obj, path) {
  let cur = obj;
  for (const key of path) {
    if (!cur || typeof cur !== "object" || !Object.hasOwn(cur, key)) return false;
    cur = cur[key];
  }
  return true;
}

describe("Rückweg 7.21.1 → 7.21.0", () => {
  it("Schema-Defaults, Setup und Installer schreiben keinen der neuen Schlüssel", () => {
    const defaults = manifestConfigDefaults();
    for (const path of NEW_KEYS) assert.equal(has(defaults, path), false, `default ${path.join(".")}`);
    for (const profile of [recommendedProfile(), safeProfile()]) {
      const config = applyFeatureProfile({}, profile).plugins.entries["memory-lancedb-namespaced"].config;
      for (const path of NEW_KEYS) assert.equal(has(config, path), false, `${profile.setupProfile}: ${path.join(".")}`);
    }
  });

  it("die Upgrade-Hinweise nennen jeden neuen Schlüssel und den Rückweg", () => {
    const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
    const start = changelog.indexOf("## [7.21.1]");
    assert.ok(start >= 0, "7.21.1 section");
    const section = changelog.slice(start, changelog.indexOf("\n## [", start + 1));
    const notes = section.slice(section.indexOf("Upgrade-Hinweise:"), section.indexOf("\n", section.indexOf("Upgrade-Hinweise:")));
    for (const path of NEW_KEYS) assert.ok(notes.includes(`\`${path.join(".")}\``), path.join("."));
    assert.match(notes, /zurückgeht.*aus `openclaw\.json` entfernen/);
  });
});
