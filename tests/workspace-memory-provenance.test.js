import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  classifyWorkspaceMemoryPath,
  classifyWorkspaceMemoryPaths,
  ELIGIBLE_MEMORY_ORIGIN_CLASSES,
} from "../lib/setup/workspace-memory-provenance.js";
import { createMemoryHostRuntime } from "../lib/setup/memory-host-runtime.js";
import { makeTempDir } from "./helpers/temp-dir.js";

let root;
let ws;
let outside;

before(() => {
  root = makeTempDir("plur1bus-provenance-");
  ws = path.join(root, "workspace");
  outside = path.join(root, "outside.md");
  mkdirSync(path.join(ws, "memory", "dreaming"), { recursive: true });
  mkdirSync(path.join(ws, "notes"), { recursive: true });
  for (const rel of ["MEMORY.md", "USER.md", "DREAMS.md", "AGENTS.md", "memory/2026-09-07.md", "memory/KNOWLEDGE.md", "memory/dreaming/light.md", "memory/notes.txt", "notes/plan.md"]) {
    writeFileSync(path.join(ws, rel), `# ${rel}\n`);
  }
  writeFileSync(outside, "# outside\n");
  symlinkSync(outside, path.join(ws, "memory", "escape.md"));
});

after(() => { rmSync(root, { recursive: true, force: true }); });

describe("workspace memory provenance — host classification rules", () => {
  it("classifies curated roots and memory notes as agent, dreams as system, the rest as untrusted", async () => {
    const result = await classifyWorkspaceMemoryPaths({
      workspaceDir: ws,
      relativePaths: ["MEMORY.md", "USER.md", "memory/2026-09-07.md", "memory/KNOWLEDGE.md", "DREAMS.md", "memory/dreaming/light.md", "AGENTS.md", "memory/notes.txt", "notes/plan.md"],
    });
    assert.deepEqual(result.map((r) => `${r.relativePath}=${r.originClass}`), [
      "MEMORY.md=agent",
      "USER.md=agent",
      "memory/2026-09-07.md=agent",
      "memory/KNOWLEDGE.md=agent",
      "DREAMS.md=system",
      "memory/dreaming/light.md=system",
      "AGENTS.md=untrusted",
      "memory/notes.txt=untrusted",
      "notes/plan.md=untrusted",
    ]);
    assert.ok(ELIGIBLE_MEMORY_ORIGIN_CLASSES.includes("agent"));
  });

  it("never lets a path escape the workspace, and reports missing files as untrusted", async () => {
    const result = await classifyWorkspaceMemoryPaths({
      workspaceDir: ws,
      relativePaths: ["memory/escape.md", "../outside.md", "memory/missing.md", ""],
    });
    assert.deepEqual(result.map((r) => r.originClass), ["untrusted", "untrusted", "untrusted", "untrusted"]);
    assert.equal((await classifyWorkspaceMemoryPath({ workspaceDir: ws, absolutePath: path.join(ws, "MEMORY.md"), source: "sessions" })).originClass, "untrusted");
    assert.equal((await classifyWorkspaceMemoryPath({ workspaceDir: ws, absolutePath: path.join(ws, "MEMORY.md") })).curatedRoot, true);
  });

  it("tolerates missing input without throwing", async () => {
    assert.deepEqual(await classifyWorkspaceMemoryPaths({}), []);
    assert.deepEqual(await classifyWorkspaceMemoryPaths({ relativePaths: ["MEMORY.md"] }), [{ relativePath: "MEMORY.md", originClass: "untrusted" }]);
  });
});

describe("memory host runtime — classifyWorkspaceMemoryPaths capability", () => {
  const runtime = () => createMemoryHostRuntime({
    recall: async () => [],
    readCard: async () => null,
    provider: () => ({ provider: "openai", model: "text-embedding-3-large" }),
    embed: async () => [0.1],
    hostConfig: () => ({ agents: { defaults: { workspace: "/nowhere" }, entries: { main: { workspace: ws } } } }),
  });

  it("exposes the method the host probes for and answers with the host's shape", async () => {
    const rt = runtime();
    assert.equal(typeof rt.classifyWorkspaceMemoryPaths, "function");
    const out = await rt.classifyWorkspaceMemoryPaths({ cfg: {}, agentId: "main", workspaceDir: ws, relativePaths: ["MEMORY.md", "USER.md"] });
    assert.deepEqual(out, [{ relativePath: "MEMORY.md", originClass: "agent" }, { relativePath: "USER.md", originClass: "agent" }]);
  });

  it("falls back to the agent's configured workspace when the host passes none", async () => {
    const out = await runtime().classifyWorkspaceMemoryPaths({ agentId: "main", relativePaths: ["USER.md", "AGENTS.md"] });
    assert.deepEqual(out.map((r) => r.originClass), ["agent", "untrusted"]);
  });
});
