import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { selectSemanticDiscoveryWorkspaces } from "../index.js";

describe("semantic discovery cron scope", () => {
  it("selects only workspaces assigned to the triggering agent", () => {
    const workspaces = selectSemanticDiscoveryWorkspaces({
      workspaces: [
        { workspace_id: "alpha-primary", agent_id: "alpha", path: "/tmp/alpha-primary" },
        { workspace_id: "beta-primary", agent_id: "beta", path: "/tmp/beta-primary" },
        { workspace_id: "alpha-secondary", agent_id: "alpha", path: "/tmp/alpha-secondary" },
      ],
    }, "alpha");

    assert.deepEqual(
      workspaces.map(({ workspaceId, agentId, path }) => ({ workspaceId, agentId, path })),
      [
        { workspaceId: "alpha-primary", agentId: "alpha", path: "/tmp/alpha-primary" },
        { workspaceId: "alpha-secondary", agentId: "alpha", path: "/tmp/alpha-secondary" },
      ],
    );
  });
});
