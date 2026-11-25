// 7.21.2: Rückweg auf 7.21.1 — recall.contextWeighting kennt das alte Schema
// nicht; Setup und Installer schreiben es nicht, die Upgrade-Hinweise nennen es.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { manifestConfigDefaults } from "../lib/setup/config-contract.js";
import { applyFeatureProfile, recommendedProfile, safeProfile } from "../lib/setup/feature-profiles.js";

describe("Rückweg 7.21.2 → 7.21.1", () => {
  it("Schema-Defaults, Setup und Installer schreiben recall.contextWeighting nicht", () => {
    assert.equal(Object.hasOwn(manifestConfigDefaults().recall || {}, "contextWeighting"), false);
    for (const profile of [recommendedProfile(), safeProfile()]) {
      const config = applyFeatureProfile({}, profile).plugins.entries["memory-lancedb-namespaced"].config;
      assert.equal(Object.hasOwn(config.recall || {}, "contextWeighting"), false, profile.setupProfile);
    }
  });

  it("die Upgrade-Hinweise nennen den Schlüssel, die Spalten und den Rückweg", () => {
    const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
    const start = changelog.indexOf("## [7.21.2]");
    const section = changelog.slice(start, changelog.indexOf("\n## [", start + 1));
    assert.match(section, /`recall\.contextWeighting`/);
    assert.match(section, /`sensitivity`/);
    assert.match(section, /zurückgeht.*aus `openclaw\.json` entfernen/);
  });
});
