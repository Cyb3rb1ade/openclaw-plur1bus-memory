import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeDiscoveredObsidianWorkspaces } from "../lib/obsidian-bridge.js";
import { confirmedObsidianPolicy } from "./helpers/obsidian-mutation-policy.js";

describe("writeDiscoveredObsidianWorkspaces — malformed config", () => {
  it("throws a clear error (not a raw SyntaxError) when the OpenClaw config is invalid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-discover-"));
    const configPath = join(dir, "openclaw.json");
    writeFileSync(configPath, "{ this is not valid json", "utf8");
    const mutationPolicy = confirmedObsidianPolicy({
      baseDbPath: dir,
      command: ["discover", "workspaces", "--write"],
    });

    assert.throws(
      () => writeDiscoveredObsidianWorkspaces(configPath, [], { backupDir: dir, mutationPolicy }),
      (err) => {
        // Must name the config and signal it is malformed — a bare
        // "Unexpected token ... in JSON" leaks the parser internals and
        // gives the operator no actionable hint about which file to fix.
        const msg = String(err?.message || err);
        assert.match(msg, /malformed|invalid JSON/i, `unhelpful error message: ${msg}`);
        assert.ok(msg.includes(configPath), `error should name the config path: ${msg}`);
        return true;
      },
    );
  });
});
