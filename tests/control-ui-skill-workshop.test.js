import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { applyControlUiWriteAction, createFormTokenStore } from "../lib/setup/control-ui-write.js";
import { createControlUiHttpHandler } from "../lib/setup/control-ui-plugin-runtime.js";
import { projectSkillWorkshop } from "../lib/control-plane-projection.js";
import { collectSkillWorkshopProposals } from "../lib/setup/skill-workshop-dashboard.js";
import { writeProposal } from "../lib/jobs/skill-miner/proposal-writer.js";

const ID = "55555555-5555-4555-8555-555555555555";
const ID2 = "66666666-6666-4666-8666-666666666666";

function form(pairs) {
  return new URLSearchParams(pairs);
}

function fakeResponse() {
  const headers = new Map();
  return {
    statusCode: 0,
    body: "",
    setHeader(name, value) { headers.set(String(name).toLowerCase(), value); },
    getHeader(name) { return headers.get(String(name).toLowerCase()); },
    end(body = "") { this.body = body; },
  };
}

const HOSTILE = "<script>alert(1)</script>";

function skillWorkshopFixture() {
  return projectSkillWorkshop({
    available: true,
    mode: "host",
    hostMode: "auto",
    autoApply: true,
    workspaces: [{
      id: "workspace-bernhardine",
      agents: [{
        agentId: "bernhardine",
        proposals: [
          {
            id: ID,
            status: "pending_review",
            skillName: "nightscout-hypo-alert",
            skillTitle: `Hypo Alert ${HOSTILE}`,
            description: `Warns early ${HOSTILE}`,
            benefit: `Fewer missed lows ${HOSTILE}`,
            instructions: `1. Read Nightscout\n2. ${HOSTILE}`,
            examples: [HOSTILE],
            category: "workflow",
            proposedAt: "2026-09-06T04:17:43.603Z",
            evidence: { memoryIds: ["a", "b", "c"], score: 4, llmConfidence: 0.82, grade: "corroborated" },
            openClawWorkshop: { proposalId: "nightscout-1", revisionHash: "a".repeat(64), status: "pending" },
          },
          {
            id: ID2,
            status: "pending_review",
            skillName: "old-unbound",
            skillTitle: "Old Unbound",
            proposedAt: "2026-08-23T04:18:08.822Z",
            evidence: { memoryIds: ["x"] },
          },
          { id: "77777777-7777-4777-8777-777777777777", status: "rejected", skillName: "gone" },
        ],
      }],
    }],
  });
}

describe("7.12.48: mined skills in the projection", () => {
  it("whitelists statuses, bounds text, counts and orders proposals", () => {
    const projected = skillWorkshopFixture();
    assert.deepEqual(projected.counts, { pending: 2, active: 0, rejected: 1 });
    const cards = projected.workspaces[0].agents[0].proposals;
    assert.equal(cards.length, 2);
    assert.equal(cards[0].id, ID, "newest pending first");
    assert.equal(cards[0].bound, true);
    assert.equal(cards[1].bound, false);
    assert.equal(cards[0].memories, 3);
    const long = projectSkillWorkshop({ workspaces: [{ id: "w", agents: [{ agentId: "main", proposals: [{ id: ID, status: "active", description: "x".repeat(5000), instructions: "y".repeat(9000) }] }] }] });
    const card = long.workspaces[0].agents[0].proposals[0];
    assert.ok(card.description.length <= 600);
    assert.ok(card.instructions.length <= 4000);
    assert.equal(long.mode, "host");
    assert.equal(long.hostMode, "auto");
    assert.equal(long.available, false);
    const junk = projectSkillWorkshop({ workspaces: [{ id: "w", agents: [{ agentId: "../evil", proposals: [{ id: ID, status: "active" }] }, { agentId: "main", proposals: [{ id: "not-a-uuid", status: "active" }, { id: ID, status: "weird" }] }] }] });
    assert.deepEqual(junk.workspaces[0].agents.map((agent) => agent.agentId), ["main"]);
    assert.equal(junk.workspaces[0].agents[0].proposals.length, 0);
  });

  it("groups ledgers by workspace basename and skips agents without proposals", (t) => {
    const ledgerA = mkdtempSync(join(tmpdir(), "dash-ledger-a-"));
    const ledgerB = mkdtempSync(join(tmpdir(), "dash-ledger-b-"));
    const empty = mkdtempSync(join(tmpdir(), "dash-ledger-empty-"));
    t.after(() => [ledgerA, ledgerB, empty].forEach((dir) => rmSync(dir, { recursive: true, force: true })));
    writeProposal(ledgerA, { id: ID, skillName: "a", status: "pending_review" });
    writeProposal(ledgerB, { id: ID2, skillName: "b", status: "active" });
    const collected = collectSkillWorkshopProposals({ agents: [
      { agentId: "main", workspace: "/root/.openclaw/workspace", ledgerDirs: [ledgerA] },
      { agentId: "developer", workspace: "/root/.openclaw/workspace", ledgerDirs: [empty] },
      { agentId: "bernhardine", workspace: "/root/.openclaw/workspace-bernhardine", ledgerDirs: [ledgerB, ledgerB] },
    ] });
    assert.deepEqual(collected.workspaces.map((workspace) => workspace.id), ["workspace", "workspace-bernhardine"]);
    assert.deepEqual(collected.workspaces[0].agents.map((agent) => agent.agentId), ["main"]);
    assert.equal(collected.workspaces[1].agents[0].proposals.length, 1);
    assert.equal(collected.workspaces[1].agents[0].proposals[0].ledgerDir, ledgerB);
  });
});

describe("7.12.48: mined skills panel", () => {
  const render = async (mode) => {
    const handler = createControlUiHttpHandler({
      getProjection: async () => ({ schemaVersion: 2, skillWorkshop: skillWorkshopFixture() }),
      write: mode === "off" ? null : { mode, tokens: createFormTokenStore(), applyAction: async () => ({ code: "failed" }) },
    });
    const response = fakeResponse();
    await handler({ method: "GET", url: "/plugins/memory-lancedb-namespaced/control", headers: { host: "127.0.0.1:18789" } }, response);
    return response.body;
  };

  it("escapes every model-derived field", async () => {
    const body = await render("all");
    assert.ok(!body.includes(HOSTILE), "no raw script from the ledger");
    assert.ok(body.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
    assert.match(body, /Mined Skills/);
    assert.match(body, /Workspace <code>workspace-bernhardine<\/code>/);
    assert.match(body, /Benefit<\/span> Fewer missed lows/);
  });

  it("offers approve and decline for bound drafts, decline only for unbound ones, in mode all", async () => {
    const body = await render("all");
    const approve = body.match(/name="action" value="skill\.approve"/g) || [];
    const reject = body.match(/name="action" value="skill\.reject"/g) || [];
    assert.equal(approve.length, 1);
    assert.equal(reject.length, 2);
    assert.match(body, new RegExp(`name="proposal" value="${ID}"`));
    assert.match(body, /can only be declined/);
  });

  it("renders no skill forms in read-only or reranker mode", async () => {
    for (const mode of ["off", "reranker"]) {
      const body = await render(mode);
      assert.ok(!/value="skill\./.test(body), `no skill forms in ${mode}`);
      assert.match(body, /controlUi\.writeActions: &quot;all&quot;|controlUi.writeActions: "all"/);
    }
  });

  it("tolerates a projection without the section", async () => {
    const handler = createControlUiHttpHandler({ getProjection: async () => ({ schemaVersion: 2 }) });
    const response = fakeResponse();
    await handler({ method: "GET", url: "/plugins/memory-lancedb-namespaced/control", headers: {} }, response);
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /No mined skills yet/);
  });
});

describe("7.12.48: skill write actions", () => {
  const calls = [];
  const deps = {
    logger: { warn() {} },
    approveSkill: async (input) => { calls.push(["approve", input]); return { ok: true, status: "active" }; },
    rejectSkill: async (input) => { calls.push(["reject", input]); return { ok: true }; },
    retireSkill: async (input) => { calls.push(["retire", input]); return { ok: true, removed: true }; },
  };

  it("is refused outside mode all", async () => {
    const result = await applyControlUiWriteAction({ action: "skill.approve", form: form({ agent: "main", proposal: ID }), mode: "reranker", deps });
    assert.equal(result.code, "denied_mode");
  });

  it("validates agent and proposal ids before touching anything", async () => {
    calls.length = 0;
    for (const [agent, proposal] of [["../main", ID], ["main", "x"], ["", ID], ["main", `${ID}' OR 1=1`]]) {
      const result = await applyControlUiWriteAction({ action: "skill.reject", form: form({ agent, proposal }), mode: "all", deps });
      assert.equal(result.code, "denied_skill");
    }
    assert.equal(calls.length, 0);
  });

  it("dispatches approve, decline and withdraw with stable result codes", async () => {
    calls.length = 0;
    const pairs = { agent: "bernhardine", proposal: ID };
    assert.equal((await applyControlUiWriteAction({ action: "skill.approve", form: form(pairs), mode: "all", deps })).code, "skill_approved");
    assert.equal((await applyControlUiWriteAction({ action: "skill.reject", form: form(pairs), mode: "all", deps })).code, "skill_rejected");
    assert.equal((await applyControlUiWriteAction({ action: "skill.retire", form: form(pairs), mode: "all", deps })).code, "skill_retired");
    assert.deepEqual(calls.map(([name]) => name), ["approve", "reject", "retire"]);
    assert.deepEqual(calls[0][1], { agentId: "bernhardine", proposalId: ID });
  });

  it("maps declined outcomes to readable codes", async () => {
    const outcome = (result) => ({ ...deps, approveSkill: async () => result });
    const run = async (result) => (await applyControlUiWriteAction({ action: "skill.approve", form: form({ agent: "main", proposal: ID }), mode: "all", deps: outcome(result) })).code;
    assert.equal(await run({ ok: true, partial: true }), "skill_approved_partial");
    assert.equal(await run({ ok: false, reason: "not_found" }), "skill_not_found");
    assert.equal(await run({ ok: false, reason: "unbound" }), "skill_unbound");
    assert.equal(await run({ ok: false, reason: "workshop_not_pending" }), "skill_not_pending");
    assert.equal(await run({ ok: false, reason: "workshop_apply_failed" }), "skill_failed");
    const missing = await applyControlUiWriteAction({ action: "skill.retire", form: form({ agent: "main", proposal: ID }), mode: "all", deps: { logger: deps.logger } });
    assert.equal(missing.code, "denied_action");
  });
});
