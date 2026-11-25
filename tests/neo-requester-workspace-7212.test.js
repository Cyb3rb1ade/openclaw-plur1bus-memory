/**
 * tests/neo-requester-workspace-7212.test.js — 7.21.2 ACL fix.
 *
 * Host hooks carry no workspaceKey, so neoRequester() produced an empty
 * requesterWorkspaceKey and every workspace_shared Neo record was invisible,
 * even to its own main agent. The key now comes from the workspace directory
 * through configured paths/aliases only; "shared" stays: main agent plus its
 * subagents in the same workspace, never across workspaces.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildNeoWorkspaceAliases, isNeoRecordAccessible, workspaceKeyFromDirStrict } from "../lib/neo-arch.js";

const aliases = buildNeoWorkspaceAliases({
  obsidianBridge: {
    workspaces: [
      { id: "main", agentId: "main", path: "/srv/oc/workspace" },
      { id: "bernhardine", agentId: "bernhardine", path: "/srv/oc/workspace-bernhardine" },
    ],
  },
});
const key = (dir) => workspaceKeyFromDirStrict(dir, { workspaceAliases: aliases, rootDir: "/srv/oc/neo" });
const shared = (workspaceKey) => ({ id: "c1", agentId: "bernhardine", workspaceKey, visibility: { scope: "workspace_shared" } });

describe("workspaceKeyFromDirStrict", () => {
  it("maps configured workspace directories, nothing else", () => {
    assert.equal(key("/srv/oc/workspace"), "main");
    assert.equal(key("/srv/oc/workspace-bernhardine"), "bernhardine");
    assert.equal(key("/srv/oc/workspace-bernhardine/"), "bernhardine");
    assert.equal(key("/srv/oc/workspace-unknown"), "", "no basename guess");
    assert.equal(key("/tmp/elsewhere/workspace"), "", "a foreign directory with the same name is not main");
    assert.equal(key("/tmp/elsewhere/workspace-bernhardine"), "");
    assert.equal(key(""), "");
    assert.equal(key(undefined), "");
  });

  it("no default workspace key and no single-store fallback", () => {
    const withDefault = workspaceKeyFromDirStrict("/elsewhere", { workspaceAliases: aliases, defaultWorkspaceKey: "main", corpusDefaultWorkspaceKey: "main" });
    assert.equal(withDefault, "");
  });
});

describe("workspace_shared visibility with the derived key", () => {
  it("main agent and its subagents (same directory) see it; other main agents never", () => {
    const bern = { requesterAgentId: "bernhardine", requesterWorkspaceKey: key("/srv/oc/workspace-bernhardine") };
    const bernSub = { requesterAgentId: "bernhardine-developer", requesterWorkspaceKey: key("/srv/oc/workspace-bernhardine") };
    const main = { requesterAgentId: "main", requesterWorkspaceKey: key("/srv/oc/workspace") };
    const unknown = { requesterAgentId: "x", requesterWorkspaceKey: key("/srv/oc/other") };
    assert.equal(isNeoRecordAccessible(shared("bernhardine"), bern), true);
    assert.equal(isNeoRecordAccessible(shared("bernhardine"), bernSub), true);
    assert.equal(isNeoRecordAccessible(shared("bernhardine"), main), false);
    assert.equal(isNeoRecordAccessible(shared("bernhardine"), unknown), false);
    assert.equal(isNeoRecordAccessible(shared(""), bern), false, "a record without key stays invisible");
  });

  it("neoRequester falls back to the strict directory key, after explicit keys", () => {
    const source = readFileSync(new URL("../engine/create-engine.js", import.meta.url), "utf8");
    const block = source.slice(source.indexOf("const neoRequester = "), source.indexOf("const snapshotNeoContent"));
    assert.match(block, /workspaceKeyFromDirStrict\(/);
    assert.doesNotMatch(block, /workspaceKeyFromContext\(/, "never the permissive resolver with defaults");
  });
});
