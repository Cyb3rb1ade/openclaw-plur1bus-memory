// 7.20.10: Rückweg auf 7.20.9. Das Schema von 7.20.9 kennt die neuen Schlüssel
// nicht (additionalProperties false) und lehnt die ganze Plugin-Konfiguration
// ab. Setup und Installer dürfen sie deshalb nicht von selbst schreiben, und
// die Upgrade-Hinweise nennen sie.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { manifestConfigDefaults } from "../lib/setup/config-contract.js";
import { applyFeatureProfile, recommendedProfile, safeProfile } from "../lib/setup/feature-profiles.js";

const NEW_KEYS = [
  ["reranker", "maxDocChars"],
  ["embedding", "cleanText"],
  ["recall", "qualityWeighting"],
  ["recall", "volatileStateAnnotation"],
  ["neo", "recall", "maxReflections"],
  ["neo", "recall", "laneMinRelevance"],
];

function has(obj, path) {
  let cur = obj;
  for (const key of path) {
    if (!cur || typeof cur !== "object" || !Object.hasOwn(cur, key)) return false;
    cur = cur[key];
  }
  return true;
}

describe("Rückweg 7.20.10 → 7.20.9", () => {
  it("Schema-Defaults, Setup und Installer schreiben keinen der neuen Schlüssel", () => {
    const defaults = manifestConfigDefaults();
    for (const path of NEW_KEYS) assert.equal(has(defaults, path), false, `default ${path.join(".")}`);
    for (const profile of [recommendedProfile(), safeProfile()]) {
      const config = applyFeatureProfile({}, profile).plugins.entries["memory-lancedb-namespaced"].config;
      assert.ok(config && typeof config === "object");
      for (const path of NEW_KEYS) assert.equal(has(config, path), false, `${profile.setupProfile}: ${path.join(".")}`);
    }
  });

  it("die Upgrade-Hinweise nennen jeden neuen Schlüssel und den Rückweg", () => {
    const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
    const section = changelog.slice(changelog.indexOf("## [7.20.10]"), changelog.indexOf("## [7.20.9]"));
    const notes = section.slice(section.indexOf("### Upgrade notes"));
    for (const path of NEW_KEYS) assert.ok(notes.includes(`\`${path.join(".")}\``), path.join("."));
    assert.match(notes, /remove them from `openclaw\.json` before rolling back/);
  });
});
