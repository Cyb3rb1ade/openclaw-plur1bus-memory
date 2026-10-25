"""Real copied wrappers/manager/bridge/helper, only provider and ffmpeg doubled."""
import json,os,pathlib,shutil,subprocess,tempfile,unittest
ROOT=pathlib.Path(__file__).resolve().parents[1]
AGENTS={'main':'workspace','bernhardine':'workspace-bernhardine','heisenberg':'workspace-heisenberg'}
def assert_fixture_safe(base):
 for p in base.rglob('*'):
  if p.is_file() and p.suffix in ('.sh','.py','.mjs'):
   source=p.read_text()
   if '/root/.openclaw' in source or '/tmp/openclaw' in source:
    raise AssertionError('live path in copied fixture: '+str(p))

class FixtureGuardTests(unittest.TestCase):
 def test_live_destination_is_rejected_before_commands(self):
  with tempfile.TemporaryDirectory() as d:
   base=pathlib.Path(d);(base/'manager.sh').write_text('STATE_DIR="/root/.openclaw/settings/tts-toggle"')
   with self.assertRaises(AssertionError):assert_fixture_safe(base)

class WrapperTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.base=pathlib.Path(self.tmp.name)
  self.env=dict(os.environ,TEST_LOG=str(self.base/'calls'),ELEVENLABS_API_KEY='test-secret',PYTHONPATH=str(self.base),TYPESAFE_API_KEY='')
  fake=self.base/'external-tools';fake.mkdir();ff=fake/'ffmpeg';ff.write_text('#!/usr/bin/env python3\nimport os,pathlib,sys\nif os.getenv("FAIL_CONVERT"):sys.exit(1)\npathlib.Path(sys.argv[-1]).write_bytes(b"audio")\n');ff.chmod(0o755);self.env['PATH']=str(fake)+':'+os.environ['PATH']
  (self.base/'sitecustomize.py').write_text('''import urllib.request,json,os
class Response:
 def __enter__(self):return self
 def __exit__(self,*a):pass
 def read(self):return b'a'*1024
def send(req,**kwargs):
 body=json.loads(req.data)
 with open(os.environ['TEST_LOG'],'a') as f:f.write(json.dumps({'body':body,'url':req.full_url})+'\\n')
 if os.getenv('FAIL_SYNTH') or body['text']=='FAIL':raise TimeoutError()
 return Response()
urllib.request.urlopen=send
''')
  for agent,ws in AGENTS.items():
   dest=self.base/ws/'skills/telegram-tts-toggle';shutil.copytree(ROOT/'scripts/telegramTts'/agent,dest)
   for p in (dest/'bin').glob('*.sh'):
    s=p.read_text()
    for w in sorted(AGENTS.values(),key=len,reverse=True):s=s.replace('/root/.openclaw/'+w,str(self.base/w))
    s=s.replace('/root/.openclaw/settings/tts-toggle',str(self.base/'toggles')).replace('/root/.openclaw/tools/elevenlabs-tts.py',str(self.base/'helper.py')).replace('/root/.openclaw/tools/plur1bus-speech-bridge.py',str(self.base/'bridge.py')).replace('/tmp/openclaw',str(self.base/'audio'))
    s=s.replace('/root/.openclaw',str(self.base/'runtime'))
    p.write_text(s);p.chmod(0o755)
  (self.base/'helper.py').write_text((ROOT/'scripts/telegramTts/elevenlabs-tts.py').read_text().replace('/root/.openclaw',str(self.base/'runtime')).replace('/tmp/openclaw',str(self.base/'audio')));(self.base/'helper.py').chmod(0o755)
  config={'agents':{'list':[{'id':a,'workspace':str(self.base/w)} for a,w in AGENTS.items()]},'plugins':{'entries':{'memory-lancedb-namespaced':{'config':{}}}}};(self.base/'config.json').write_text(json.dumps(config));(self.base/'config.json').chmod(0o600)
  cli=(ROOT/'scripts/plan-speech.mjs').read_text().replace("'../lib/telegramSpeech.js'",json.dumps((ROOT/'lib/telegramSpeech.js').as_uri())).replace('/root/.openclaw/openclaw.json',str(self.base/'config.json'))
  (self.base/'planner.mjs').write_text(cli)
  bridge=(ROOT/'scripts/telegramTts/speech-bridge.py').read_text().replace('/root/.openclaw/extensions/memory-lancedb-namespaced/scripts/plan-speech.mjs',str(self.base/'planner.mjs')).replace('/root/.openclaw/tools/elevenlabs-tts.py',str(self.base/'helper.py'));(self.base/'bridge.py').write_text(bridge)
  # Fail before the first subprocess: no copied executable may retain a live destination.
  assert_fixture_safe(self.base)
  self.set_enabled(True)
 def manager(self,agent,*args):
  return subprocess.run(['bash',str(self.base/AGENTS[agent]/'skills/telegram-tts-toggle/bin/tts-manager.sh'),*args],env=self.env,capture_output=True,text=True)
 def set_enabled(self,enabled):
  for a in AGENTS:
   r=self.manager(a,'enable' if enabled else 'disable',a);self.assertEqual(r.returncode,0,r.stderr)
   r=self.manager(a,'set-voice',a,'el-otto');self.assertEqual(r.returncode,0,r.stderr)
 def run_script(self,agent,name,*args):
  return subprocess.run(['bash',str(self.base/AGENTS[agent]/'skills/telegram-tts-toggle/bin'/name),agent,*args],env=self.env,capture_output=True,text=True,timeout=15)
 def calls(self):
  p=self.base/'calls';return [json.loads(l) for l in p.read_text().splitlines()] if p.exists() else []
 def expressive_config(self,mode):
  p=self.base/'config.json';c=json.loads(p.read_text());c['plugins']['entries']['memory-lancedb-namespaced']['config']={'emotion':{'jev':{'enabled':True,'agents':{a:True for a in AGENTS},'mode':mode}},'captureChunkingJev':{'apiKey':'synthetic-jev-key'}};p.write_text(json.dumps(c))
  preload=self.base/'fetch.mjs';preload.write_text("""import fs from 'node:fs';
  globalThis.fetch=async(url,request)=>{const body=JSON.parse(request.body);fs.appendFileSync(process.env.JEV_LOG,JSON.stringify({questions:Object.keys(body.questions),context:JSON.parse(body.state).context})+'\\n');const answers=Object.fromEntries(Object.keys(body.questions).map(k=>[k,{type:'choice',choice:k.startsWith('pair_')?'equivalent':k.endsWith('_action')?'none':k.endsWith('_intent')?'praise':'warm',confidence:1}]));return {ok:true,json:async()=>({answers})};};
  """)
  self.env['NODE_OPTIONS']='--import '+str(preload);self.env['JEV_LOG']=str(self.base/'jev-calls')
 def test_bilingual_active_batches_once_and_shadow_sends_neutral(self):
  for mode in ['active','shadow']:
   self.expressive_config(mode)
   r=self.run_script('bernhardine','tts-bilingual.sh','Danke 🐈','Dziękuję 🐈');self.assertEqual(r.returncode,0,r.stderr);self.assertEqual(len(r.stdout.splitlines()),2)
  calls=self.calls();self.assertEqual([c['body']['text'] for c in calls],['[warm]Danke 🐈','[warm]Dziękuję 🐈','Danke 🐈','Dziękuję 🐈']);self.assertEqual(len(set(c['url'] for c in calls)),1)
  jev=[json.loads(l) for l in (self.base/'jev-calls').read_text().splitlines()];self.assertEqual(len(jev),2);self.assertTrue(all('v0_s0_intent' in j['questions'] and 'v1_s0_intent' in j['questions'] for j in jev))
 def test_bound_run_context_is_used_and_stale_or_forged_context_is_not_borrowed(self):
  import time
  self.expressive_config('active');private=self.base/'workspace'/'.plur1bus';private.mkdir(mode=0o700);directory=private/'speech-context';directory.mkdir(mode=0o700);file=directory/('a'*64+'.json');now=int(time.time()*1000)
  context={'version':1,'agentId':'main','runId':'exact-run','sessionId':'session','createdAt':now-100,'expiresAt':now+60000,'mood':{'joy':.5},'persona':'','context':[{'role':'user','content':'Synthetic current user'}]};file.write_text(json.dumps(context));file.chmod(0o600);self.env['PLUR1BUS_SPEECH_CONTEXT_FILE']=str(file);self.env['PLUR1BUS_SPEECH_RUN_ID']='exact-run'
  for case in ['bound','forged','stale']:
   if case=='forged':self.env['PLUR1BUS_SPEECH_RUN_ID']='different-run'
   if case=='stale':self.env['PLUR1BUS_SPEECH_RUN_ID']='exact-run';context['createdAt']=now-2000;context['expiresAt']=now-1000;file.write_text(json.dumps(context))
   r=self.run_script('main','tts-auto.sh','Danke');self.assertEqual(r.returncode,0,r.stderr)
  logged=[json.loads(l)['context'] for l in (self.base/'jev-calls').read_text().splitlines()];self.assertEqual(logged,[[{'role':'user','content':'Synthetic current user'}],[],[]])
 def test_mixed_text_keeps_speaker_and_unique_file(self):
  paths=[]
  for _ in range(2):
   r=self.run_script('bernhardine','tts-auto.sh','Guten Tag. Dzień dobry. Jetzt weiter po polsku.');self.assertEqual(r.returncode,0,r.stderr);paths.append(r.stdout.strip())
  self.assertNotEqual(*paths);self.assertEqual(len(self.calls()),2);self.assertEqual(len(set(c['url'] for c in self.calls())),1)
 def test_all_identities_exact_words_stdout_and_no_fallback(self):
  for a in AGENTS:
   r=self.run_script(a,'tts-auto.sh','**Danke** 🐈');self.assertEqual(r.returncode,0,r.stderr);self.assertTrue(r.stdout.startswith('OK:'),r.stdout);self.assertEqual(len(r.stdout.splitlines()),1);self.assertNotIn('test-secret',r.stdout+r.stderr)
  self.assertEqual([c['body']['text'] for c in self.calls()],['Danke 🐈']*3)
 def test_disabled_no_calls(self):
  self.set_enabled(False);r=self.run_script('main','tts-auto.sh','Hallo');self.assertEqual(r.stdout,'');self.assertEqual(self.calls(),[])
 def test_raw_directives_text_only(self):
  r=self.run_script('main','tts-auto.sh','[laughs] Hallo');self.assertNotEqual(r.returncode,0);self.assertEqual(r.stdout,'');self.assertEqual(self.calls(),[])
 def test_synth_and_conversion_failure_no_success(self):
  for key in ['FAIL_SYNTH','FAIL_CONVERT']:
   self.env[key]='1';r=self.run_script('main','tts-auto.sh','Hallo');self.assertNotEqual(r.returncode,0);self.assertEqual(r.stdout,'');self.env.pop(key)
 def test_empty_language_is_skipped_without_false_partial_failure(self):
  r=self.run_script('bernhardine','tts-bilingual.sh','','Dzień dobry.');self.assertEqual(r.returncode,0,r.stderr);self.assertTrue(r.stdout.startswith('OK_PL:'),r.stdout);self.assertEqual(len(self.calls()),1)
 def test_partial_bilingual_success_and_one_speaker(self):
  r=self.run_script('bernhardine','tts-bilingual.sh','Hallo','FAIL');self.assertNotEqual(r.returncode,0);self.assertTrue(r.stdout.startswith('OK_DE:'),r.stdout+r.stderr);self.assertNotIn('OK_PL:',r.stdout)
  self.assertEqual([c['body']['text'] for c in self.calls()],['Hallo','FAIL']);self.assertEqual(len(set(c['url'] for c in self.calls())),1)
if __name__=='__main__':unittest.main(verbosity=2)
