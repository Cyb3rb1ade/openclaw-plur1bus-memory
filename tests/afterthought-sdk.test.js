import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadOpenClawPluginSdkRuntime } from "../lib/setup/feature-cron-plugin-runtime.js";
import { makeTempDir } from "./helpers/temp-dir.js";

test("loads transcript and session capabilities from the selected host instead of the development pin", async () => {
  const root = makeTempDir("afterthought-host-sdk-");
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "openclaw", type: "module", exports: {
    "./plugin-sdk/session-store-runtime": "./dist/store.js",
    "./plugin-sdk/session-transcript-runtime": "./dist/transcript.js",
  } }));
  writeFileSync(join(root, "dist/store.js"), "export const getSessionEntry = () => ({sessionId:'original-host-session'});");
  writeFileSync(join(root, "dist/transcript.js"), "export const readSessionTranscriptEvents = async () => [{type:'compaction',summary:'early decision'}];");
  const options = { packageManifestPath: join(root, "package.json") };
  const sessions = await loadOpenClawPluginSdkRuntime("session-store-runtime", options);
  const transcripts = await loadOpenClawPluginSdkRuntime("session-transcript-runtime", options);
  assert.equal(sessions.getSessionEntry().sessionId, "original-host-session");
  assert.deepEqual(await transcripts.readSessionTranscriptEvents(), [{ type: "compaction", summary: "early decision" }]);
});
