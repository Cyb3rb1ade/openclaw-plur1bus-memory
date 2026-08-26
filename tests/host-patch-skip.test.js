import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

describe("retired PLUR1BUS host-patch switch", () => {
  it("is absent from the feature-cron runtime and setup paths", () => {
    const indexSource = readFileSync(new URL("../index.js", import.meta.url), "utf8");
    const setupSource = readFileSync(new URL("../scripts/setup-feature-crons.mjs", import.meta.url), "utf8");
    const runtimeSource = readFileSync(new URL("../lib/setup/feature-cron-plugin-runtime.js", import.meta.url), "utf8");

    for (const source of [indexSource, setupSource, runtimeSource]) {
      assert.doesNotMatch(source, /PLUR1BUS_SKIP_HOST_PATCH/);
      assert.doesNotMatch(source, /applyCronPluginDirectDispatchPatch/);
    }
  });
});
