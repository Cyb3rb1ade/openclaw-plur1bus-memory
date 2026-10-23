import assert from "node:assert/strict";
import { test } from "node:test";
import { extractSkillFromEvidence } from "../lib/jobs/skill-miner/llm-extractor.js";
import { runSkillMiner } from "../lib/jobs/skill-miner.js";
import { makeTempDir } from "./helpers/temp-dir.js";

test("extraction keeps stable instructions separate and limits evidence and same-owner catalogue context",async()=>{
 const memories=Array.from({length:40},(_,i)=>({id:`m${i}`,text:"evidence ".repeat(1000),createdAt:i}));
 let messages;
 const result=await extractSkillFromEvidence({memories},{agentId:"a",llmCfg:{model:"existing-sonnet-override"},existingSkills:Array.from({length:20},(_,i)=>({skillName:`s${i}`,instructions:"old ".repeat(3000)})),callLlm:async(m,cfg)=>{
  messages=m;assert.equal(cfg.model,"existing-sonnet-override");
  return JSON.stringify({skillName:"next",targetSkillName:"s0",instructions:"Review sources",confidence:0.9});
 }});
 assert.equal(messages[0].role,"system");assert.equal(messages[1].role,"user");
 assert.doesNotMatch(messages[0].content,/evidence evidence|s0/);
 const data=JSON.parse(messages[1].content);
 assert.equal(data.memories.length,12);assert.ok(data.memories.every(m=>m.text.length<=1800));
 assert.equal(data.memories[0].id,"m39");
 assert.equal(data.existingSkills.length,8);assert.ok(data.existingSkills.every(s=>s.instructions.length<=1200));
 assert.deepEqual(result.evidenceMemoryIds,data.memories.map(m=>m.id));
});
test("model cannot select a foreign or unseen update target",async()=>{
 const result=await extractSkillFromEvidence({memories:[{id:"1",text:"trusted evidence"}]},{agentId:"a",llmCfg:{},existingSkills:[{skillName:"local"}],callLlm:async()=>JSON.stringify({skillName:"new",instructions:"steps",targetSkillName:"foreign",confidence:0.9})});
 assert.equal(result.skip,true);assert.equal(result.reason,"invalid_response");
});
test("rejected candidates cannot cause unbounded extraction calls or cache untouched groups",async()=>{
 const rows=Array.from({length:30},(_,i)=>({id:`m${i}`,text:`${String.fromCharCode(97+Math.floor(i/2)).repeat(8)} ${String.fromCharCode(97+Math.floor(i/2)).repeat(10)}`,category:"workspace_rule",epistemicStatus:"trusted",createdAt:Date.now(),status:"active",scope:"agent-private",agentId:"a",storedBy:"a"}));
 const db={async init(){},table:{query(){return {limit(){return this;},async toArray(){return rows;}};}}};
 let calls=0;
 const result=await runSkillMiner(db,"a",{workspaceDir:makeTempDir("skill-budget-"),maxPerRun:2,cutoffState:{ok:true,since:0,legacyOpen:true},llmCfg:{},callLlm:async()=>{calls++;return JSON.stringify({skip:true,confidence:0});}});
 assert.equal(calls,2);assert.equal(result.llmCalls,2);assert.equal(result.extractionBudgetExhausted,true);
});
