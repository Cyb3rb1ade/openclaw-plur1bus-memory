import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { makeTempDir } from "./helpers/temp-dir.js";
import { createOpenClawSkillWorkshopClient } from "../lib/setup/skill-workshop-plugin-runtime.js";
import { writeProposal, readProposals, markProposalStatus, patchProposal, isSkillNameBlocked } from "../lib/jobs/skill-miner/proposal-writer.js";
import { activateSkillProposal } from "../lib/telegram-commands/skill-commands.js";
import { runSkillMiner } from "../lib/jobs/skill-miner.js";

const revision = "a".repeat(64);
const body = "---\nname: municipal-work\ndescription: Check municipal responsibilities\n---\n\n# Municipal work\n\nCheck sources and jurisdiction.\n\nManual addition: record hearing dates.\n";
const hash = createHash("sha256").update(body).digest("hex");
const base = { id: "base", agentId: "a", skillName: "municipal-work", skillTitle: "Municipal work", description: "Check municipal responsibilities", instructions: "Check sources and jurisdiction.", status: "active", evidence: { memoryIds: ["old"] } };
const addition = { id: "next", agentId: "a", skillName: "municipal-work", updateOf: "base", description: base.description, instructions: "Distinguish Gemeinde and Samtgemeinde responsibilities before drafting.", status: "pending_review", evidence: { memoryIds: [] }, openClawWorkshop: { proposalId: "update-1", revisionHash: revision, baseContentHash: hash, status: "pending", operation: "update" } };

function clientFixture(boundHash = hash, rejectFails = false) {
  const calls = [];
  return { calls, client: createOpenClawSkillWorkshopClient({ loadGatewayRuntime: async () => ({
    async callGatewayFromCli(method, _options, params) {
      calls.push({method, params});
      if (method === "skills.workshop.read") return { name: base.skillName, skillKey: base.skillName, content: body };
      if (method === "skills.proposals.update") return { record: { id: "update-1", status: "pending", target: { skillKey: base.skillName, currentContentHash: boundHash } }, revisionHash: revision };
      if (method === "skills.proposals.reject") {
        if (rejectFails) throw new Error("rollback unavailable");
        return { id: "update-1", status: "rejected" };
      }
      throw new Error(`Unexpected ${method}`);
    },
  }) }) };
}

test("extension drafts append to the actual same-agent Workshop content including manual additions", async () => {
  const {client,calls} = clientFixture();
  const result = await client.updateProposal({agentId:"a",proposal:addition});
  assert.deepEqual(calls.map(c=>c.method), ["skills.workshop.read","skills.proposals.update"]);
  assert.deepEqual(calls[0].params, {agentId:"a",name:"municipal-work"});
  assert.ok(calls[1].params.content.startsWith(body));
  assert.match(calls[1].params.content, /Manual addition: record hearing dates/);
  assert.match(calls[1].params.content, /Distinguish Gemeinde and Samtgemeinde/);
  assert.equal(calls[1].params.expectedCurrentContentHash, undefined);
  assert.equal(result.baseContentHash, hash);
  assert.equal(result.operation, "update");
});

test("a base-content race rejects only the new draft and surfaces rollback failure", async () => {
  const fixture = clientFixture("b".repeat(64));
  await assert.rejects(fixture.client.updateProposal({agentId:"a",proposal:addition}), /base.*changed/i);
  assert.deepEqual(fixture.calls.at(-1).params, {agentId:"a",proposalId:"update-1",expectedRevisionHash:revision,reason:"Rejected through the authorized PLUR1BUS Skill Miner review flow."});
  const failed = clientFixture("b".repeat(64),true);
  await assert.rejects(failed.client.updateProposal({agentId:"a",proposal:addition}), /rollback unavailable/);
});

test("same-name updates retain the old active record until successful activation, then preserve history", async () => {
  const dir=makeTempDir("skill-extension-");
  assert.equal(writeProposal(dir,base).written,true);
  assert.equal(writeProposal(dir,addition).written,true);
  assert.equal(readProposals(dir)[0].status,"active");
  patchProposal(dir,"next",{status:"active"});
  const records=readProposals(dir);
  assert.equal(records[0].status,"superseded");
  assert.equal(records[0].supersededBy,"next");
  assert.equal(records[0].instructions,base.instructions);
  assert.equal(records[1].status,"active");
});

test("update persistence rejects foreign owners, missing base hashes and concurrent pending extensions", () => {
  for (const invalid of [{...addition,agentId:"other"},{...addition,openClawWorkshop:undefined},{...addition,updateOf:"missing"}]) {
    const dir=makeTempDir("skill-extension-invalid-");writeProposal(dir,base);
    assert.equal(writeProposal(dir,invalid).written,false);
  }
  const dir=makeTempDir("skill-extension-concurrent-");writeProposal(dir,base);writeProposal(dir,addition);
  assert.equal(writeProposal(dir,{...addition,id:"third"}).written,false);
});

test("rejecting an extension leaves its active base eligible and retains the rejected version", () => {
  const dir=makeTempDir("skill-extension-reject-");writeProposal(dir,base);writeProposal(dir,addition);
  markProposalStatus(dir,"next","rejected");
  assert.equal(readProposals(dir)[0].status,"active");
  assert.equal(readProposals(dir)[1].status,"rejected");
  assert.equal(writeProposal(dir,{...addition,id:"different",instructions:"Record a genuinely different committee workflow."}).written,true);
  assert.equal(isSkillNameBlocked(dir,base.skillName),true);
});

test("an update cannot fall back to direct file activation without Workshop", async () => {
  const dir=makeTempDir("skill-extension-no-host-");writeProposal(dir,base);writeProposal(dir,addition);
  const path=join(dir,"skills","municipal-work","SKILL.md");mkdirSync(join(dir,"skills","municipal-work"),{recursive:true});writeFileSync(path,body);
  const result=await activateSkillProposal(dir,"next",{});
  assert.equal(result.ok,false);
  assert.equal(readFileSync(path,"utf8"),body);
  assert.equal(readProposals(dir)[0].status,"active");
});

test("miner publishes an existing workflow through update rather than a renamed create", async () => {
  const dir=makeTempDir("skill-extension-miner-");writeProposal(dir,base);
  const rows=[1,2].map(i=>({id:`new-${i}`,text:"Distinguish Gemeinde and Samtgemeinde responsibilities before drafting.",category:"workspace_rule",scope:"agent-private",agentId:"a",storedBy:"a",epistemicStatus:"trusted",createdAt:Date.now(),status:"active"}));
  const db={async init(){},table:{query(){return {limit(){return this;},async toArray(){return rows;}};}}};
  let updates=0;
  const result=await runSkillMiner(db,"a",{workspaceDir:dir,cutoffState:{ok:true,since:0,legacyOpen:true},llmCfg:{model:"keep-this-override"},callLlm:async(_messages,cfg)=>{
    assert.equal(cfg.model,"keep-this-override");
    return JSON.stringify({...addition,skillName:"municipal-new-name",targetSkillName:base.skillName,confidence:0.9});
  },requireSkillWorkshop:true,skillWorkshop:{async createProposal(){assert.fail("must update");},async updateProposal(){updates++;return {proposalId:"update-1",revisionHash:revision,status:"pending",skillName:base.skillName,baseContentHash:hash,operation:"update"};}}});
  assert.equal(updates,1);
  assert.equal(result.proposalsCreated,1,JSON.stringify(result));
  assert.equal(readProposals(dir)[1].updateOf,"base");
  assert.equal(readProposals(dir)[1].skillName,base.skillName);
});

test("successful Workshop extension activates one current version and preserves existing instructions",async()=>{
 const dir=makeTempDir("skill-extension-apply-");writeProposal(dir,base);writeProposal(dir,{...addition});
 const path=join(dir,"skills","municipal-work","SKILL.md");mkdirSync(join(dir,"skills","municipal-work"),{recursive:true});writeFileSync(path,body);
 const result=await activateSkillProposal(dir,"next",{agentId:"a",skillWorkshop:{
  async inspectProposal(){return {proposalId:"update-1",revisionHash:revision,status:"pending",skillName:"municipal-work"};},
  async applyProposal(input){assert.equal(input.expectedRevisionHash,revision);writeFileSync(path,body+"\n"+addition.instructions);return {proposalId:"update-1",status:"applied",targetSkillFile:path};},
 }});
 assert.equal(result.ok,true);
 const records=readProposals(dir);assert.equal(records[0].status,"superseded");assert.equal(records[1].status,"active");
 assert.ok(records[1].instructions.startsWith(base.instructions));
 assert.ok(readFileSync(path,"utf8").startsWith(body));
});

test("changed Workshop revision cannot replace an installed skill or supersede its history",async()=>{
 const dir=makeTempDir("skill-extension-stale-");writeProposal(dir,base);writeProposal(dir,{...addition});
 let applies=0;
 const result=await activateSkillProposal(dir,"next",{agentId:"a",skillWorkshop:{
  async inspectProposal(){return {proposalId:"update-1",revisionHash:"c".repeat(64),status:"pending",skillName:"municipal-work"};},
  async applyProposal(){applies++;},
 }});
 assert.equal(result.ok,false);assert.equal(applies,0);assert.equal(readProposals(dir)[0].status,"active");
});
test("reading a never-created owner ledger remains empty and does not create directories",()=>{
 const dir=makeTempDir("skill-extension-empty-");
 assert.deepEqual(readProposals(join(dir,"missing","owner")),[]);
 assert.equal(isSkillNameBlocked(join(dir,"missing","owner"),"municipal-work"),false);
});
