import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { readRuntimeSources } from "./helpers/runtime-sources.js";

describe("retired PLUR1BUS host-patch switch", () => {
  it("is absent from the feature-cron runtime and setup paths", () => {
    // Task 13b: index.js is the entry shell now; register() lives in
    // adapter/openclaw/plugin.js over engine/create-engine.js, so the ban
    // covers every runtime source (index.js included).
    const runtimeSources = readRuntimeSources().all;
    const setupSource = readFileSync(new URL("../scripts/setup-feature-crons.mjs", import.meta.url), "utf8");
    const runtimeSource = readFileSync(new URL("../lib/setup/feature-cron-plugin-runtime.js", import.meta.url), "utf8");

    for (const source of [...runtimeSources, setupSource, runtimeSource]) {
      assert.doesNotMatch(source, /PLUR1BUS_SKIP_HOST_PATCH/);
      assert.doesNotMatch(source, /applyCronPluginDirectDispatchPatch/);
    }
  });
});
