import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDir } from './helpers/temp-dir.js';
import { readFileSync } from 'node:fs';
const source=readFileSync(new URL('./fixtures/telegramSpeech/bash-tools-host.mjs',import.meta.url),'utf8');
test('trusted host projection ignores model env/workdir; wrapper wins and missing workspace stays absent',async()=>{
 const {patchExecContextSource}=await import('../scripts/telegramTts/patch-exec-speech-context.mjs');
 const patched=patchExecContextSource(source);assert.notEqual(patched,source);assert.equal(patchExecContextSource(patched),patched);
 const {call}=await import('data:text/javascript;base64,'+Buffer.from(patched).toString('base64'));
 const seen=[];const hook={runResolveExecEnv:async(event,ctx)=>{seen.push(ctx);return {KEPT:'yes'}}};
 const params={agentId:'main',defaults:{runId:'default',sessionKey:'session',cwd:'/fake-cwd',messageProvider:'telegram'}};
 const result=await Promise.all(['one','two'].map(runId=>call(params,{hookContext:{agentId:'main',sessionKey:'session',runId,workspaceDir:'/trusted'}},{env:{PLUR1BUS_SPEECH_RUN_ID:'forged'},workdir:'/forged',runId:'forged'},hook)));
 assert.deepEqual(result,[{KEPT:'yes'},{KEPT:'yes'}]);assert.deepEqual(seen.map(c=>c.runId),['one','two']);assert.ok(seen.every(c=>c.workspaceDir==='/trusted'));
 await call(params,{}, {workdir:'/forged'},hook);assert.equal(seen[2].runId,'default');assert.equal('workspaceDir' in seen[2],false);
 await call({...params,defaults:{}},{},{},hook);assert.equal('runId' in seen[3],false);
});
test('unsupported and ambiguous caller shapes refuse without changing source',async()=>{
 const {patchExecContextSource}=await import('../scripts/telegramTts/patch-exec-speech-context.mjs');
 assert.throws(()=>patchExecContextSource(source+source));assert.throws(()=>patchExecContextSource(source.replace('messageProvider: params.defaults?.messageProvider','messageProvider: changed')));
});

test('copied bundle applies atomically once, passes syntax, and ambiguous targets remain unchanged',async()=>{
 const {writeFileSync,readFileSync}=await import('node:fs');const {join}=await import('node:path');const {spawnSync}=await import('node:child_process');
 const {patchExecContextDirectory}=await import('../scripts/telegramTts/patch-exec-speech-context.mjs');const dir=makeTempDir('speech-host-');const file=join(dir,'bash-tools-fixture.mjs');writeFileSync(file,source);
 assert.equal(patchExecContextDirectory(dir).changed,true);assert.equal(readFileSync(file,'utf8'),source);assert.equal(patchExecContextDirectory(dir,true).changed,true);const once=readFileSync(file,'utf8');assert.equal(patchExecContextDirectory(dir,true).changed,false);assert.equal(readFileSync(file,'utf8'),once);assert.equal(spawnSync('node',['--check',file]).status,0);
 writeFileSync(join(dir,'bash-tools-ambiguous.mjs'),source);assert.throws(()=>patchExecContextDirectory(dir,true));assert.equal(readFileSync(file,'utf8'),once);
});

test('patched copied caller reaches actual runtime with two distinct run-bound speech files',async t=>{
 const {rmSync}=await import('node:fs');const {join}=await import('node:path');const {createJevEmotionRuntime,createSharedJevEmotionalPool}=await import('../lib/jevEmotionRuntime.js');const {patchExecContextSource}=await import('../scripts/telegramTts/patch-exec-speech-context.mjs');
 const root=makeTempDir('speech-seam-');t.after(()=>rmSync(root,{recursive:true,force:true}));
 const config={baseDbPath:root,emotion:{jev:{enabled:true,agents:{main:true},mode:'active'}}};const runtime=createJevEmotionRuntime({api:{on(){}},config,emotionalPool:createSharedJevEmotionalPool(config),isEligible:()=>true,assessor:async()=>({ok:true,reaction:{joy:.5,sadness:0,anger:0,fear:0,disgust:0,surprise:0,trust:.5,anticipation:0},confidence:1,sections:[]})});t.after(()=>runtime.endRun({},{}));
 const base={agentId:'main',sessionKey:'agent:main:telegram:fixture',sessionId:'session',workspaceDir:root};
 for(const runId of ['one','two']) await runtime.beforePrompt({currentUserMessage:'Synthetic authored request',currentUserMessageId:'current'}, {...base,runId});
 const {call}=await import('data:text/javascript;base64,'+Buffer.from(patchExecContextSource(source)).toString('base64'));const hook={runResolveExecEnv:(event,ctx)=>runtime.resolveExecEnv(event,ctx)};const params={agentId:'main',defaults:{runId:'wrong-default',cwd:'/not-workspace'}};
 const results=await Promise.all(['one','two'].map(runId=>call(params,{hookContext:{...base,runId}},{env:{PLUR1BUS_SPEECH_RUN_ID:'forged'},workdir:'/forged'},hook)));
 assert.deepEqual(results.map(r=>r.PLUR1BUS_SPEECH_RUN_ID),['one','two']);assert.notEqual(results[0].PLUR1BUS_SPEECH_CONTEXT_FILE,results[1].PLUR1BUS_SPEECH_CONTEXT_FILE);
 assert.deepEqual(await call(params,{hookContext:{...base,workspaceDir:undefined,runId:'one'}},{workdir:root},hook),{});
});
