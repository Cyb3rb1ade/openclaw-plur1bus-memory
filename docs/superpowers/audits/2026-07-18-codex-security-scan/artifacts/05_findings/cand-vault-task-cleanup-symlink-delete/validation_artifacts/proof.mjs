import assert from "node:assert/strict";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const targetRoot = process.argv[2];
if (!targetRoot) throw new Error("usage: node proof.mjs <repository-root>");
const root = mkdtempSync(join(tmpdir(), "plur1bus-cleanup-symlink-"));
const workspace = join(root, "workspace");
const outside = join(root, "outside");
const targetName = "missing-status-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.md";
mkdirSync(join(workspace, "records"), { recursive: true });
mkdirSync(outside, { recursive: true });
symlinkSync(outside, join(workspace, "records", "tasks"));
const outsideFile = join(outside, targetName);
writeFileSync(outsideFile, "outside sentinel", "utf8");

process.env.PLUR1BUS_VAULTS = JSON.stringify([{ name: "proof", path: workspace }]);
await import(`${pathToFileURL(join(targetRoot, "scripts", "cleanup-vault-missing-tasks.mjs")).href}?proof=${Date.now()}`);
assert.equal(existsSync(outsideFile), false, "cleanup should have deleted the outside file through the tasks symlink");
console.log(JSON.stringify({ reproduced: true, workspace, outside, deleted: outsideFile }, null, 2));
