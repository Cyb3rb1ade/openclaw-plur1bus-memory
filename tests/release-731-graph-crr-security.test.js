import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildEdgesForSession,
  createEdge,
  readGraph,
} from "../lib/memory-graph.js";
import {
  markUserTurn,
  runConversationReactivationRecall,
} from "../lib/conversation-reactivation-recall.js";
import { resolveMemoryRequestContext } from "../lib/memory-request-context.js";
import { createRecallDecisionTrace } from "../lib/recall-decision-trace.js";

const EMPTY_ALIASES = Object.freeze({ paths: Object.freeze([]), aliases: Object.freeze([]) });
const NOW = 1_800_000_000_000;

function makeContext({ workspaceId = "workspace-a", userId = "owner-a" } = {}) {
  return resolveMemoryRequestContext({
    agentId: "agent-a",
    workspaceId,
    channel: "telegram",
    accountId: "primary",
    userId,
  }, { workspaceAliases: EMPTY_ALIASES });
}

function makeWorkspaceMemory(id, workspace = "workspace-a", overrides = {}) {
  const workspaceIdentity = `workspace:v1:${workspace}`;
  return {
    id,
    text: `${id} protected dashboard material`,
    summary: "",
    status: "active",
    expiresAt: 0,
    scope: "workspace",
    agentId: "agent-a",
    storedBy: "agent-a",
    workspaceId: workspaceIdentity,
    workspaceKey: workspaceIdentity,
    ownerUserId: "",
    vector: [0.1, 0.2, 0.3],
    ...overrides,
  };
}

function makeUserMemory(id, ownerUserId, overrides = {}) {
  return {
    id,
    text: `${id} private dashboard material`,
    summary: "",
    status: "active",
    expiresAt: 0,
    scope: "user",
    agentId: "agent-a",
    storedBy: "agent-a",
    workspaceId: "",
    workspaceKey: "",
    ownerUserId,
    vector: [0.1, 0.2, 0.3],
    ...overrides,
  };
}

function canonicalGraphOwnershipForTest(memory) {
  return {
    schemaVersion: 1,
    scope: memory.scope || "agent-private",
    agentId: memory.agentId || memory.storedBy || "",
    workspaceIdentity: memory.workspaceId || memory.workspaceKey || "",
    ownerUserId: memory.ownerUserId || "",
  };
}

function makeTable(rows) {
  return {
    vectorSearch() {
      return {
        limit() {
          return { toArray: async () => rows };
        },
      };
    },
  };
}

const crrConfig = Object.freeze({
  enabled: true,
  idleThresholdMinutes: 45,
  cooldownMinutes: 0,
  maxReactivationMemories: 3,
  maxFadedReactivationMemories: 1,
  maxOpenThreads: 3,
  maxCommunities: 2,
});

async function runGraphCrr({ requestContext, baseMemory, targetMemory, edge, getMemoryById }) {
  const agentId = `release-731-${Math.random()}`;
  const sessionKey = `session-${Math.random()}`;
  markUserTurn(agentId, sessionKey, NOW - 60 * 60 * 1000);
  const trace = createRecallDecisionTrace({ query: "continue dashboard material" });
  const hydratedIds = [];
  const result = await runConversationReactivationRecall({
    prompt: "continue dashboard material",
    messageText: "continue dashboard material",
    baseRecallIds: new Set([baseMemory.id]),
    baseRecallTopScore: 0.1,
    workspaceDir: null,
    neoStore: null,
    graphEdges: [edge],
    cfg: crrConfig,
    agentId,
    sessionKey,
    now: NOW,
    logger: { warn() {}, debug() {} },
    requestContext,
    getMemoryById: async (id) => {
      hydratedIds.push(id);
      return getMemoryById ? getMemoryById(id) : (id === targetMemory.id ? targetMemory : null);
    },
    decisionTrace: trace,
  });
  return { ...result, hydratedIds, trace };
}

describe("release 7.3.1 graph-to-CRR scope boundary", () => {
  it("filters ANN lifecycle/ACL candidates and preserves canonical endpoint ownership tuples", async () => {
    const requestContext = makeContext();
    const base = makeWorkspaceMemory("z-base", "workspace-a");
    const allowed = makeWorkspaceMemory("a-allowed", "workspace-a");
    const foreign = makeWorkspaceMemory("b-foreign", "workspace-b");
    const archived = makeWorkspaceMemory("c-archived", "workspace-a", { status: "archived" });
    const edges = await buildEdgesForSession(
      [base],
      [allowed, foreign, archived],
      makeTable([
        { id: allowed.id, _distance: 0.1 },
        { id: foreign.id, _distance: 0.1 },
        { id: archived.id, _distance: 0.1 },
      ]),
      null,
      { requestContext, now: NOW },
    );

    const semanticEdges = edges.filter((edge) => edge.type === "semantic");
    assert.equal(semanticEdges.length, 1, "only the live ACL-authorized ANN row may receive an edge");
    const [edge] = semanticEdges;
    assert.equal(edge.source, "a-allowed");
    assert.equal(edge.target, "z-base");
    assert.deepEqual(edge.sourceOwnership, canonicalGraphOwnershipForTest(allowed));
    assert.deepEqual(edge.targetOwnership, canonicalGraphOwnershipForTest(base));
    assert.deepEqual(edge.ownership, {
      source: edge.sourceOwnership,
      target: edge.targetOwnership,
    });
    assert.equal(edge.needsRebuild, false);
  });

  it("rejects workspace and user foreign graph bridges, including legacy unbound edges, before hydration/tracing", async () => {
    const workspaceContext = makeContext({ workspaceId: "workspace-a", userId: "owner-a" });
    const foreignWorkspace = makeWorkspaceMemory("foreign-workspace", "workspace-b");
    const workspaceBase = makeWorkspaceMemory("workspace-base", "workspace-a");
    const userB = makeContext({ workspaceId: "workspace-a", userId: "owner-b" });
    const foreignUser = makeUserMemory("foreign-user", userB.userPrincipal);
    const userBase = makeUserMemory("user-base", workspaceContext.userPrincipal);

    const cases = [
      {
        label: "workspace",
        requestContext: workspaceContext,
        base: workspaceBase,
        foreign: foreignWorkspace,
      },
      {
        label: "user",
        requestContext: workspaceContext,
        base: userBase,
        foreign: foreignUser,
      },
    ];

    for (const testCase of cases) {
      const boundForeignEdge = createEdge(
        testCase.base.id,
        testCase.foreign.id,
        "semantic",
        0.9,
        false,
        {
          sourceOwnership: canonicalGraphOwnershipForTest(testCase.base),
          targetOwnership: canonicalGraphOwnershipForTest(testCase.foreign),
        },
      );
      const boundResult = await runGraphCrr({
        requestContext: testCase.requestContext,
        baseMemory: testCase.base,
        targetMemory: testCase.foreign,
        edge: boundForeignEdge,
      });
      assert.deepEqual(boundResult.additions, [], `${testCase.label}: foreign bound edge must not bridge`);
      assert.equal(boundResult.context.includes(testCase.foreign.text), false, `${testCase.label}: foreign text must not render`);
      assert.deepEqual(boundResult.hydratedIds, [], `${testCase.label}: ACL must run before hydration`);
      assert.equal(boundResult.trace.candidates.some((candidate) => candidate.id === testCase.foreign.id), false, `${testCase.label}: denied endpoint must not be traced`);

      const legacyResult = await runGraphCrr({
        requestContext: testCase.requestContext,
        baseMemory: testCase.base,
        targetMemory: testCase.foreign,
        edge: { source: testCase.base.id, target: testCase.foreign.id, type: "semantic", strength: 0.9 },
      });
      assert.deepEqual(legacyResult.additions, [], `${testCase.label}: legacy unbound edge must be ignored`);
      assert.equal(legacyResult.context.includes(testCase.foreign.text), false, `${testCase.label}: legacy edge must not render foreign text`);
      assert.deepEqual(legacyResult.hydratedIds, [], `${testCase.label}: legacy edge must not hydrate an endpoint`);
    }

    const missingContextResult = await runGraphCrr({
      requestContext: null,
      baseMemory: workspaceBase,
      targetMemory: foreignWorkspace,
      edge: createEdge(
        workspaceBase.id,
        foreignWorkspace.id,
        "semantic",
        0.9,
        false,
        {
          sourceOwnership: canonicalGraphOwnershipForTest(workspaceBase),
          targetOwnership: canonicalGraphOwnershipForTest(foreignWorkspace),
        },
      ),
    });
    assert.deepEqual(missingContextResult.additions, [], "protected graph CRR requires canonical request context");
    assert.deepEqual(missingContextResult.hydratedIds, []);
  });

  it("keeps an authorized graph bridge additive and verifies hydrated ownership before rendering", async () => {
    const requestContext = makeContext();
    const base = makeWorkspaceMemory("base", "workspace-a");
    const allowed = makeWorkspaceMemory("allowed", "workspace-a");
    const edge = createEdge(
      base.id,
      allowed.id,
      "semantic",
      0.9,
      false,
      {
        sourceOwnership: canonicalGraphOwnershipForTest(base),
        targetOwnership: canonicalGraphOwnershipForTest(allowed),
      },
    );

    const result = await runGraphCrr({
      requestContext,
      baseMemory: base,
      targetMemory: allowed,
      edge,
    });
    assert.deepEqual(result.additions.map((memory) => memory.id), [allowed.id]);
    assert.match(result.context, /allowed protected dashboard material/);
    assert.deepEqual(result.hydratedIds, [allowed.id]);

    const mismatched = await runGraphCrr({
      requestContext,
      baseMemory: base,
      targetMemory: allowed,
      edge,
      getMemoryById: async () => makeWorkspaceMemory("allowed", "workspace-b"),
    });
    assert.deepEqual(mismatched.additions, [], "hydrated row ownership must match the edge tuple");
    assert.equal(mismatched.context.includes("workspace-b"), false);

    const wrongId = await runGraphCrr({
      requestContext,
      baseMemory: base,
      targetMemory: allowed,
      edge,
      getMemoryById: async () => makeWorkspaceMemory("different", "workspace-a"),
    });
    assert.deepEqual(wrongId.additions, [], "hydrated row identity must match the graph endpoint");
    assert.equal(wrongId.context.includes("different protected dashboard material"), false);
  });

  it("marks compatibility-created unbound edges for rebuild and never accepts them as CRR graph input", async () => {
    const base = { id: "base", vector: [0.1, 0.2], createdAt: new Date(NOW).toISOString() };
    const legacy = { id: "legacy", vector: [0.1, 0.2], createdAt: new Date(NOW).toISOString() };
    const edges = await buildEdgesForSession([base], [legacy], makeTable([{ ...legacy, _distance: 0.1 }]), null);
    const edge = edges.find((candidate) => candidate.type === "semantic");
    assert.ok(edge, "legacy compatibility path should be explicit, not silently trusted");
    assert.equal(edge.needsRebuild, true);
    const legacyRead = readGraph([{ source: "base", target: "legacy", type: "semantic", strength: 0.9 }]);
    assert.equal(legacyRead.edges[0].needsRebuild, true, "raw legacy graph records must be explicitly marked");
    assert.equal(readGraph([edge], { requireBoundOwnership: true }).edges.length, 0);
    const result = await runGraphCrr({
      requestContext: makeContext(),
      baseMemory: base,
      targetMemory: legacy,
      edge,
    });
    assert.deepEqual(result.additions, []);
    assert.deepEqual(result.hydratedIds, []);
  });
});
