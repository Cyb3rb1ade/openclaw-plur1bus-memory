import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patchSoulMd } from "../lib/install/soul-patcher.js";

function backupNames(dir) {
  return readdirSync(dir).filter((name) => name.startsWith("SOUL.MD.bak-plur1bus-soul-"));
}

describe("soul patcher backups", () => {
  it("prunes old SOUL.MD backups to the configured limit", () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-soul-backups-"));

    try {
      const target = join(dir, "SOUL.MD");
      writeFileSync(target, "Existing SOUL text\n", "utf8");
      for (let i = 0; i < 4; i++) {
        writeFileSync(`${target}.bak-plur1bus-soul-${1000 + i}`, `old backup ${i}`, "utf8");
      }

      const result = patchSoulMd(target, { maxBackups: 2 });

      assert.strictEqual(result.ok, true);
      assert.ok(backupNames(dir).length <= 2, `expected <=2 backups, got ${backupNames(dir).length}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
