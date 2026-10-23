import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runSkillMiner, clusterFingerprint } from "../lib/jobs/skill-miner.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const response = JSON.stringify({ skillName: "municipal-work", skillTitle: "Municipal work", description: "Handle municipal requests.", instructions: "Check the responsible authority and verify current sources.", confidence: 0.9 });
const negative = JSON.stringify({ skip: true, confidence: 0.2 });
function fixture(t) {
  const dir = makeTempDir("skill-learning-cache-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const rows = [0, 1].map(i => ({ id: `m${i}`, text: "Gemeinde Samtgemeinde Aufgaben Zuständigkeit prüfen und dokumentieren", category: "workspace_rule", status: "active", epistemicStatus: "trusted", createdAt: Date.now() }));
  const db = { async init() {}, table: { query() { return { limit() { return this; }, async toArray() { return rows; } }; } } };
  const options = { workspaceDir: dir, workspaceKey: "a", cutoffState: { ok: true, since: 0, legacyOpen: true }, llmCfg: { model: "model-a" }, logger: { info() {}, warn() {} } };
  const next = (mutate = () => {}) => {
    const path = join(dir, "run-state.json"); const state = JSON.parse(readFileSync(path, "utf8"));
    for (const r of Object.values(state.jobRateLimits || {})) r.lastRunAt = 0;
    mutate(state); writeFileSync(path, JSON.stringify(state));
  };
  return { dir, rows, options, next, run: (extra) => runSkillMiner(db, "a", { ...options, ...extra }) };
}

for (const failure of ["timeout", "transport", "malformed", "empty", "incomplete"]) {
  test(`does not negative-cache ${failure} extraction failure`, async (t) => {
    const f = fixture(t);let calls=0;
    const callLlm = async () => {
      if (++calls > 1) return response;
      if (failure === "timeout") throw Object.assign(new Error("timeout"), { name: "TimeoutError", code: "ETIMEOUT" });
      if (failure === "transport") throw new Error("provider unavailable");
      return failure === "malformed" ? "not-json" : failure === "empty" ? "" : JSON.stringify({ confidence: 0.9, skillName: "missing-instructions" });
    };
    const first = await f.run({ callLlm });
    assert.equal(first.extractionFailures, 1);
    assert.equal(first.skippedLowConfidence, 0);
    f.next();const second=await f.run({callLlm});
    assert.equal(second.proposalsCreated,1);assert.equal(calls,2);
  });
}

test("reuses a real rejection, expires it after seven days, and stores no evidence plaintext", async t => {
  const f=fixture(t);let calls=0;const callLlm=async()=>{calls++;return negative;};
  await f.run({callLlm});f.next();assert.equal((await f.run({callLlm})).skippedKnownCluster,1);assert.equal(calls,1);
  f.next(state=>{for(const memo of Object.values(state.skillMinerClusterMemo))for(const v of Object.values(memo))v.at=Date.now()-8*86400000;});
  await f.run({callLlm});assert.equal(calls,2);
  assert.ok(!readFileSync(join(f.dir,"run-state.json"),"utf8").includes(f.rows[0].text));
});

for(const changed of ["text","trust","model","policy"])test(`reconsiders a negative decision after ${changed} changes`,async t=>{
  const f=fixture(t);let calls=0;const callLlm=async()=>{calls++;return negative;};await f.run({callLlm});f.next();
  if(changed==="text")f.rows[0].text+=" Neue Fallunterscheidung dokumentieren";
  if(changed==="trust")f.rows[0].epistemicStatus="corroborated";
  const extra=changed==="model"?{llmCfg:{model:"model-b"}}:changed==="policy"?{minConfidence:0.8}:{};
  await f.run({callLlm,...extra});assert.equal(calls,2);
});

test("ignores unversioned historical cache entries without deleting them",async t=>{
 const f=fixture(t);await f.run({callLlm:async()=>negative});
 f.next(state=>{for(const memo of Object.values(state.skillMinerClusterMemo))for(const v of Object.values(memo))delete v.version;});
 let calls=0;await f.run({callLlm:async()=>{calls++;return response;}});assert.equal(calls,1);
});

test("decision fingerprints are stable under ordering and change with contents/model/prompt",()=>{
 const a={memories:[{id:"1",text:"one"},{id:"2",text:"two"}]};
 assert.equal(clusterFingerprint(a),clusterFingerprint({memories:[...a.memories].reverse()}));
 assert.notEqual(clusterFingerprint(a),clusterFingerprint({memories:[{id:"1",text:"changed"},{id:"2",text:"two"}]}));
 assert.notEqual(clusterFingerprint(a,{model:"a"}),clusterFingerprint(a,{model:"b"}));
 assert.notEqual(clusterFingerprint(a,{promptVersion:"one"}),clusterFingerprint(a,{promptVersion:"two"}));
});

test("semantic extraction errors are not retained in the real transport result cache",async()=>{
 const {callLlm}=await import('../lib/llm-call.js');
 const {createLlmResultCache}=await import('../lib/llm-result-cache.js');
 const {extractSkillFromEvidence}=await import('../lib/jobs/skill-miner/llm-extractor.js');
 let providerCalls=0;
 const cache=createLlmResultCache();
 const replies=[{confidence:0.9,skillName:"incomplete"},{confidence:0.9,skillName:"complete",instructions:"Check the sources."}];
 class FakeOpenAI {constructor(){this.chat={completions:{create:async()=>{providerCalls++;return {choices:[{message:{content:JSON.stringify(replies.shift())}}]};}}};}}
 const opts={agentId:"a",llmCfg:{model:"override-a"},callLlm:(messages,cfg)=>callLlm(messages,cfg,{OpenAI:FakeOpenAI,resultCache:cache})};
 const group={memories:[{id:"one",text:"Check sources"}]};
 assert.equal((await extractSkillFromEvidence(group,opts)).reason,"missing_required_fields");
 assert.equal((await extractSkillFromEvidence(group,opts)).skillName,"complete");
 assert.equal((await extractSkillFromEvidence(group,opts)).skillName,"complete");
 assert.equal(providerCalls,2);
 await cache.close();
});
