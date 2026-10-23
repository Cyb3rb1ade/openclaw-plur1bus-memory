import assert from "node:assert/strict";
import { test } from "node:test";
import * as matching from "../lib/jobs/skill-miner/candidate-matching.js";

const existing={id:"old",skillName:"municipal-work",skillTitle:"Municipal authority workflow",description:"Check municipal authority and record sources",instructions:"Check the responsible municipal authority and document current sources before drafting.",agentId:"a",status:"active",evidence:{memoryIds:["1","2","3"]}};
test("same workflow with a different name is related, unrelated shared evidence stays distinct",()=>{
 assert.equal(typeof matching.findRelatedSkill,"function");
 const same={...existing,skillName:"municipal-authority-check",id:undefined};
 assert.equal(matching.findRelatedSkill(same,[existing]).proposal.id,"old");
 const other={...same,skillTitle:"Configure database backups",description:"Back up a database",instructions:"Copy the database and test recovery from the snapshot."};
 assert.equal(matching.findRelatedSkill(other,[existing]),null);
});
test("catalogue isolates agents and excludes superseded history",()=>{
 const catalogue=matching.selectSkillCatalogue([existing,{...existing,id:"foreign",agentId:"b"},{...existing,id:"history",status:"superseded"}],{agentId:"a",ownership:{scope:"agent-private",agentId:"a"}});
 assert.deepEqual(catalogue.map(x=>x.id),["old"]);
});
test("model target must resolve within the authorized catalogue and rejected targets stay blocked",()=>{
 assert.equal(matching.findRelatedSkill({skillName:"other",targetSkillName:"absent",instructions:"x"},[existing]),null);
 const related=matching.findRelatedSkill({...existing,targetSkillName:"municipal-work"},[{...existing,status:"rejected"}]);
 assert.equal(related.proposal.status,"rejected");
});
test("new evidence for an existing workflow is an extension, unchanged equivalent evidence is a duplicate",()=>{
 assert.equal(matching.findRelatedSkill({...existing,skillName:"renamed"},[existing]).kind,"duplicate");
 assert.equal(matching.findRelatedSkill({...existing,instructions:existing.instructions+" Record the committee hearing.",evidence:{memoryIds:["1","2","3","4"]}},[existing]).kind,"extension");
});
test("focused repeated-term cohorts recover municipal evidence from a mixed group",()=>{
 const rows=[0,1,2].map(i=>({id:`m${i}`,text:`Samtgemeinde Gemeinde Zuständigkeit Fall ${i} prüfen`,category:"decision",epistemicStatus:"observed",scope:"agent-private",agentId:"a",storedBy:"a",createdAt:100+i}));
 const unrelated=Array.from({length:30},(_,i)=>({id:`x${i}`,text:`Database backup transaction ${i}`,category:"fact",epistemicStatus:"observed",scope:"agent-private",agentId:"a",storedBy:"a",createdAt:1}));
 const source=[...rows,...unrelated];const groups=matching.prepareSkillEvidenceGroups(source,[{memories:source,score:33,ownership:{scope:"agent-private",agentId:"a"}}]);
 assert.ok(groups.some(g=>g.memories.length===3&&g.memories.every(m=>m.id.startsWith("m"))));
 assert.ok(groups.length<=65);assert.ok(groups[0].memories.length<=24);
});
test("focused cohorts never cross ownership boundaries",()=>{
 const rows=["a","b"].flatMap(agentId=>[0,1].map(i=>({id:`${agentId}${i}`,text:"Samtgemeinde Zuständigkeit prüfen",category:"decision",epistemicStatus:"trusted",scope:"agent-private",agentId,storedBy:agentId})));
 const groups=matching.prepareSkillEvidenceGroups(rows,[]);
 assert.ok(groups.length>0);assert.ok(groups.every(g=>new Set(g.memories.map(m=>m.agentId)).size===1));
});
test("identical instructions remain duplicates even with fresh supporting evidence",()=>{
 assert.equal(matching.findRelatedSkill({...existing,evidence:{memoryIds:["new"]}},[existing]).kind,"duplicate");
});
test("rejected additions do not ban their active base but identical additions stay rejected",()=>{
 const rejected={...existing,id:"rejected-update",updateOf:"old",status:"rejected",extensionInstructions:"Record the statutory hearing deadline."};
 const repeat={skillName:"municipal-work",targetSkillName:"municipal-work",instructions:rejected.extensionInstructions};
 assert.equal(matching.findRelatedSkill(repeat,[existing,rejected]).proposal.id,rejected.id);
 assert.equal(matching.findRelatedSkill({...repeat,instructions:"Record a different committee responsibility."},[existing,rejected]).proposal.id,"old");
});
test("generic conversational fillers do not create focused topic cohorts",()=>{
 const rows=Array.from({length:3},(_,i)=>({id:`g${i}`,text:"Genau ich habe das jetzt hier alles schon gesagt",scope:"agent-private",agentId:"a",storedBy:"a"}));
 assert.equal(matching.prepareSkillEvidenceGroups(rows,[]).length,0);
});
test("attachment error wrappers cannot group otherwise unrelated evidence",()=>{
 const rows=["Prüfe Gemeinde und Samtgemeinde Zuständigkeit", "Kontrolliere Datenbank Backups Wiederherstellung"].map((text,i)=>({id:`f${i}`,text:`[Audio transcript (machine-generated, untrusted)]: ${text}\n<file name="random.docx" mime="application/vnd.openxmlformats-officedocument.wordprocessingml.document">[Unsupported document format: application/vnd.openxmlformats-officedocument.wordprocessingml.document. Read the file yourself]</file>`,scope:"agent-private",agentId:"a",storedBy:"a"}));
 assert.equal(matching.prepareSkillEvidenceGroups(rows,[]).length,0);
});
test("an installed addition is not appended again with the same or fresh supporting evidence",()=>{
 const active={...existing,id:"next",instructions:existing.instructions+"\n\nRecord the committee hearing.",extensionInstructions:"Record the committee hearing."};
 for(const memoryIds of [active.evidence.memoryIds,["fresh"]]) {
  const candidate={skillName:"municipal-work",targetSkillName:"municipal-work",instructions:"Record   the committee hearing.\n",evidence:{memoryIds}};
  assert.equal(matching.findRelatedSkill(candidate,[active]).kind,"duplicate");
 }
 assert.equal(matching.findRelatedSkill({skillName:"municipal-work",targetSkillName:"municipal-work",instructions:"Record a new statutory consultation.",evidence:{memoryIds:["fresh"]}},[active]).kind,"extension");
});
