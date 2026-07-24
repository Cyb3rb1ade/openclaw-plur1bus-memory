import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const targetRoot = process.argv[2];
if (!targetRoot) throw new Error("usage: node proof.mjs <repository-root>");
const { writeGraphConstellationReport } = await import(join(targetRoot, "lib", "memory-graph.js"));

const root = mkdtempSync(join(tmpdir(), "plur1bus-graph-symlink-"));
const workspace = join(root, "workspace");
const outside = join(root, "outside");
mkdirSync(join(workspace, "memory"), { recursive: true });
mkdirSync(outside, { recursive: true });
symlinkSync(outside, join(workspace, "memory", "graph"));

const returned = writeGraphConstellationReport([
  { source: "a", target: "b", type: "semantic", strength: 0.9, createdAt: new Date().toISOString() },
], workspace);
assert.ok(returned, "report writer should return a report path");
assert.ok(existsSync(returned), "lexical report path should exist");
const resolved = realpathSync(returned);
assert.ok(resolved.startsWith(`${realpathSync(outside)}/`), `expected outside write, got ${resolved}`);
assert.ok(!resolved.startsWith(`${realpathSync(workspace)}/`), `report unexpectedly remained in workspace: ${resolved}`);
console.log(JSON.stringify({ reproduced: true, workspace, outside, returned, resolved }, null, 2));
