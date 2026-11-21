import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDir } from './helpers/temp-dir.js';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
const load = () => import('../lib/telegramSpeech.js');
const config = mode => ({ emotion:{jev:{enabled:true,agents:{main:true,bernhardine:true,heisenberg:true},mode}} });
const versions = [{id:'de',text:'**Danke** 🐈.'},{id:'pl',text:'Dziękuję 🐈.'}];
for (const agentId of ['main','bernhardine','heisenberg']) test(`canonical batched final-only fallback for ${agentId}`,async()=>{
 const {planTelegramSpeech}=await load(); let calls=0;
 const result=await planTelegramSpeech({agentId,versions},{config:config('active'),planner:async input=>{calls++;assert.equal(input.context.length,0);assert.equal(input.versions[0].text,'Danke 🐈.'); return {ok:true,versions:input.versions.map(v=>({...v,segments:[{start:0,end:[...v.text].length,intent:'praise',delivery:'warm',action:'none',confidence:1}]}))};}});
 assert.equal(calls,1);assert.equal(result.versions[0].speech,'[warm]Danke 🐈.');assert.equal(result.versions[0].text,'Danke 🐈.');
});
test('disabled does not assess; shadow sends canonical neutral; raw directions block speech',async()=>{
 const {planTelegramSpeech}=await load();let calls=0;const planner=async input=>{calls++;return {ok:true,versions:input.versions}};
 const disabled=await planTelegramSpeech({agentId:'main',versions},{config:{},planner});assert.equal(disabled.mode,'disabled');assert.equal(calls,0);
 const shadow=await planTelegramSpeech({agentId:'main',versions},{config:config('shadow'),planner});assert.equal(shadow.versions[0].speech,'Danke 🐈.');
 const raw=await planTelegramSpeech({agentId:'main',versions:[{id:'de',text:'[laughs] Hallo'}]},{config:config('active'),planner});assert.equal(raw.versions[0].blocked,true);assert.equal(raw.versions[0].speech,'');assert.equal(calls,1);
});
test('private context requires bound run, agent, ownership, expiry and canonical workspace path',async()=>{
 const {readSpeechContext}=await load();const workspace=makeTempDir('speech-');const dir=join(workspace,'.plur1bus','speech-context');mkdirSync(dir,{recursive:true,mode:0o700});const file=join(dir,'a'.repeat(64)+'.json');const now=Date.now();const ctx={version:1,agentId:'main',runId:'r',sessionId:'s',createdAt:now-10,expiresAt:now+10000,mood:{joy:.5},persona:'',context:[{role:'user',content:'Danke'}]};writeFileSync(file,JSON.stringify(ctx),{mode:0o600});const opts={workspace,agentId:'main',runId:'r',file,now};assert.equal(readSpeechContext(opts).context[0].content,'Danke');
 for(const patch of [{runId:'wrong'},{agentId:'heisenberg'},{now:now+20000},{file:join(workspace,'forged.json')}]) assert.equal(readSpeechContext({...opts,...patch}),null);
 chmodSync(file,0o644);assert.equal(readSpeechContext(opts),null);
});
test('cap includes Unicode ellipsis and planner failure preserves exact canonical words',async()=>{
 const {planTelegramSpeech}=await load();const result=await planTelegramSpeech({agentId:'main',versions:[{id:'de',text:'🐈 '.repeat(2000)}]},{config:config('active'),planner:async()=>({ok:false,reason:'timeout'})});const v=result.versions[0];assert.ok([...v.text].length<=2000);assert.ok(v.text.endsWith('…'));assert.equal(v.speech,v.text);
});

test('real planner uses one combined request and selected key only; timeout degrades to canonical',async()=>{
 const {planTelegramSpeech,resolveSpeechJevKey}=await load();const root=makeTempDir('speech-key-');const file=join(root,'gateway.env');writeFileSync(file,'OTHER_SECRET=never-import\nSELECTED="selected-key"\n',{mode:0o600});
 assert.equal(resolveSpeechJevKey({apiKeyEnv:'SELECTED'},{},file),'selected-key');assert.equal(resolveSpeechJevKey({apiKey:'explicit',apiKeyEnv:'SELECTED'},{SELECTED:'inherited'},file),'explicit');assert.equal(resolveSpeechJevKey({apiKeyEnv:'SELECTED'},{SELECTED:'inherited'},file),'inherited');assert.equal(process.env.OTHER_SECRET,undefined);
 let calls=0;const fetchImpl=async(url,req)=>{calls++;const b=JSON.parse(req.body);assert.ok(b.questions.v0_s0_intent);assert.ok(b.questions.v1_s0_intent);assert.equal(req.headers.Authorization,'Bearer test');const answers=Object.fromEntries(Object.keys(b.questions).map(k=>[k,{type:'choice',choice:k.startsWith('pair_')?'equivalent':k.endsWith('_action')?'none':k.endsWith('_intent')?'praise':'warm',confidence:1}]));return {ok:true,json:async()=>({answers})};};
 const c={...config('active'),captureChunkingJev:{apiKey:'test',fetchImpl}};const result=await planTelegramSpeech({agentId:'main',versions},{config:c});assert.equal(calls,1);assert.equal(result.versions[0].speech,'[warm]Danke 🐈.');assert.equal(result.versions[1].speech,'[warm]Dziękuję 🐈.');
 c.captureChunkingJev.fetchImpl=async()=>new Promise(()=>{});c.emotion.jev.timeoutMs=15;const timed=await planTelegramSpeech({agentId:'main',versions},{config:c});assert.equal(timed.decision,'timeout');assert.ok(timed.versions.every(v=>v.speech===v.text));
});

test('context accepts full existing authored-text bound rather than imposing a second short limit',async()=>{
 const {readSpeechContext}=await load();const workspace=makeTempDir('speech-context-bound-');const privateDir=join(workspace,'.plur1bus');mkdirSync(privateDir,{mode:0o700});const directory=join(privateDir,'speech-context');mkdirSync(directory,{mode:0o700});const file=join(directory,'b'.repeat(64)+'.json');const now=Date.now();const value={version:1,agentId:'main',runId:'r',sessionId:'s',createdAt:now-10,expiresAt:now+1000,mood:{},persona:'',context:[{role:'user',content:'🐈'.repeat(5000)}]};writeFileSync(file,JSON.stringify(value),{mode:0o600});assert.equal(readSpeechContext({workspace,agentId:'main',runId:'r',file,now})?.context[0].content,value.context[0].content);
});

test('shadow exposes distinct bounded closed section decisions while provider words stay neutral',async()=>{
 const {planTelegramSpeech}=await load();
 for (const [intent,delivery] of [['praise','warm'],['boundary','firm'],['neutral','neutral']]) {
  const result=await planTelegramSpeech({agentId:'main',versions:[{id:'default',text:'Confidential final words.'}]},{config:config('shadow'),planner:async({versions})=>({ok:true,versions:versions.map(v=>({...v,secret:'never expose',segments:[{start:0,end:[...v.text].length,intent,delivery,action:'none',confidence:1,text:v.text,apiKey:'never expose'}]}))})});
  assert.equal(result.versions[0].speech,'Confidential final words.');assert.deepEqual(result.versions[0].proposed,[{section:0,intent,delivery,action:'none'}]);
  const metadata=JSON.stringify(result.versions[0].proposed);assert.ok(!metadata.includes('Confidential'));assert.ok(!metadata.includes('never expose'));
 }
 const invalid=await planTelegramSpeech({agentId:'main',versions:[{id:'default',text:'Words'}]},{config:config('shadow'),planner:async({versions})=>({ok:true,versions:versions.map(v=>({...v,segments:[{start:0,end:5,intent:'SECRET',delivery:'warm',action:'none',confidence:1}]}))})});assert.deepEqual(invalid.versions[0].proposed,[]);
});
