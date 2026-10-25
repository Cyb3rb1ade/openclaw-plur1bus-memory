import importlib.util,pathlib,tempfile,unittest
ROOT=pathlib.Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('deploy',ROOT/'scripts/telegramTts/deploy.py');deploy=importlib.util.module_from_spec(spec);spec.loader.exec_module(deploy)
class DeployTests(unittest.TestCase):
 def test_mapping_never_targets_toggle_or_host_config_and_covers_three_skills(self):
  pairs=deploy.mapping();targets=[str(t) for _,t in pairs]
  self.assertFalse(any('/settings/' in t or t.endswith('/openclaw.json') for t in targets));self.assertEqual(len(targets),len(set(targets)))
  for ws in ['workspace','workspace-bernhardine','workspace-heisenberg']:
   self.assertTrue(any('/'+ws+'/skills/telegram-tts-toggle/bin/tts-generate.sh' in t for t in targets))
 def test_startup_is_idempotent_and_refuses_ambiguous_entrypoint(self):
  source='#!/bin/bash\nrc=0\nexit $rc\n';patched=deploy.startup_source(source);self.assertEqual(deploy.startup_source(patched),patched);self.assertIn('"$DIST_DIR" --apply || rc=1',patched)
  for changed in ['exit 0\n',source+source]:
   with self.assertRaises(ValueError):deploy.startup_source(changed)
 def test_targeted_rollback_restores_only_matching_manifest_files_and_refuses_operator_changes(self):
  import json
  from unittest.mock import patch
  with tempfile.TemporaryDirectory() as d:
   base=pathlib.Path(d);runtime=base/'runtime';runtime.mkdir();dist=base/'dist';dist.mkdir();snapshot=base/'snapshot';snapshot.mkdir();target=runtime/'helper';target.write_text('installed');original=snapshot/'original';original.write_text('previous')
   (snapshot/'manifest.json').write_text(json.dumps({'files':[{'target':str(target),'backup':'original','installed':deploy.digest(target)}]}))
   with patch.object(deploy,'RUNTIME',runtime),patch.object(deploy,'DIST',dist):
    deploy.rollback(snapshot,False);self.assertEqual(target.read_text(),'installed');deploy.rollback(snapshot,True);self.assertEqual(target.read_text(),'previous')
    with self.assertRaises(ValueError):deploy.rollback(snapshot,True)
 def test_rollback_refuses_a_parent_symlink_escape_before_writing(self):
  import json
  from unittest.mock import patch
  with tempfile.TemporaryDirectory() as d:
   base=pathlib.Path(d);runtime=base/'runtime';runtime.mkdir();outside=base/'outside';outside.mkdir();(runtime/'link').symlink_to(outside,target_is_directory=True);target=runtime/'link'/'file';target.write_text('operator');snapshot=base/'snapshot';snapshot.mkdir();(snapshot/'old').write_text('old');(snapshot/'manifest.json').write_text(json.dumps({'files':[{'target':str(target),'backup':'old','installed':deploy.digest(target)}]}))
   with patch.object(deploy,'RUNTIME',runtime),patch.object(deploy,'DIST',base/'dist'):
    with self.assertRaises(ValueError):deploy.rollback(snapshot,False)
   self.assertEqual(target.read_text(),'operator')
 def test_inside_rejects_escape_and_symlink(self):
  with tempfile.TemporaryDirectory() as d:
   base=pathlib.Path(d);(base/'link').symlink_to('/tmp')
   for name in ['../escape','link/escaped']:
    with self.assertRaises(ValueError):deploy.inside(base,name)
 def test_real_install_backs_up_all_host_bundles_before_patch_and_rolls_back_with_drift_refusal(self):
  import json,shutil,subprocess,sys
  for failure in [None,'partial','operator']:
   fail_after_first_write=bool(failure)
   with tempfile.TemporaryDirectory(prefix='speech-deploy-') as d:
    base=pathlib.Path(d).resolve();runtime=base/'runtime';dist=base/'dist';package=base/'package';source=package/'scripts/telegramTts'
    runtime.mkdir();dist.mkdir();source.parent.mkdir(parents=True)
    shutil.copytree(ROOT/'scripts/telegramTts',source,ignore=shutil.ignore_patterns('__pycache__'))
    (package/'lib').symlink_to(ROOT/'lib',target_is_directory=True)
    script=source/'deploy.py'
    script.write_text(script.read_text().replace('/root/.openclaw',str(runtime)).replace('/usr/lib/node_modules/openclaw/dist',str(dist)))
    (runtime/'patches').mkdir();(runtime/'patches/apply-media-patch.sh').write_text('#!/bin/bash\nrc=0\nexit $rc\n')
    (runtime/'openclaw.json').write_text(json.dumps({'plugins':{'entries':{'memory-lancedb-namespaced':{'config':{}}}}}))
    (runtime/'openclaw.json').chmod(0o600)
    originals={}
    for name in ['bash-tools','builtin-openclaw','context-engine-maintenance']:
     target=dist/(name+'-fixture.mjs');originals[str(target)]=(ROOT/'tests/fixtures/telegramSpeech'/(name+'-host.mjs')).read_text();target.write_text(originals[str(target)])
    # Fail inside the real patch subprocess unless every original is already durable.
    patcher=source/'patch-exec-speech-context.mjs'
    guard = """import * as testFs from 'node:fs';
 if (process.argv.includes('--apply')) {
  const snapshotRoot = TEST_RUNTIME + '/.snapshots';
  const snapshot = snapshotRoot + '/' + testFs.readdirSync(snapshotRoot)[0];
  const manifest = JSON.parse(testFs.readFileSync(snapshot + '/manifest.json'));
  for (const name of ['bash-tools', 'builtin-openclaw', 'context-engine-maintenance']) {
   const target = TEST_DIST + '/' + name + '-fixture.mjs';
   const record = manifest.files.find(item => item.target === target);
   if (!record?.backup || testFs.readFileSync(snapshot + '/' + record.backup, 'utf8') !== testFs.readFileSync(target, 'utf8')) throw new Error('missing_original_before_patch');
  }
 }
 """.replace('TEST_RUNTIME',json.dumps(str(runtime))).replace('TEST_DIST',json.dumps(str(dist)))
    patched_source=patcher.read_text().replace('/usr/lib/node_modules/openclaw/dist',str(dist)).replace('#!/usr/bin/env node\n','#!/usr/bin/env node\n'+guard)
    if fail_after_first_write:
     action="writeFileSync(file, 'unknown operator bytes'); " if failure=='operator' else ''
     patched_source=patched_source.replace('renameSync(temporary, file);', "renameSync(temporary, file); "+action+"throw new Error('fixture_partial_apply');")
    patcher.write_text(patched_source)
    # All generated executable destinations must be private before any subprocess runs.
    for artifact in [script,patcher,runtime/'patches/apply-media-patch.sh']:
     text=artifact.read_text()
     self.assertNotIn('/root/.openclaw',text);self.assertNotIn('/usr/lib/node_modules/openclaw/dist',text)
     self.assertTrue(artifact.resolve().is_relative_to(base))
    def run(*args):
     return subprocess.run([sys.executable,str(script),*args],capture_output=True,text=True,check=False)
    preview=run('--host-patch');self.assertEqual(preview.returncode,0,preview.stderr)
    self.assertFalse((runtime/'.snapshots').exists())
    result=run('--host-patch','--apply')
    if fail_after_first_write:self.assertNotEqual(result.returncode,0)
    else:self.assertEqual(result.returncode,0,result.stderr)
    snapshots=list((runtime/'.snapshots').iterdir());self.assertEqual(len(snapshots),1);snapshot=snapshots[0]
    manifest=json.loads((snapshot/'manifest.json').read_text())
    host_records=[item for item in manifest['files'] if item['target'] in originals]
    self.assertEqual(len(host_records),3)
    if failure=='operator':
     first=host_records[0]
     self.assertNotEqual(first['installed'],deploy.digest(pathlib.Path(first['target'])))
     before={item['target']:pathlib.Path(item['target']).read_bytes() for item in manifest['files']}
     self.assertNotEqual(run('--rollback',str(snapshot),'--apply').returncode,0)
     self.assertEqual({name:pathlib.Path(name).read_bytes() for name in before},before)
     continue
    for item in host_records:
     self.assertEqual((snapshot/item['backup']).read_text(),originals[item['target']])
     self.assertEqual(item['installed'],deploy.digest(pathlib.Path(item['target'])))
    self.assertEqual(sum(pathlib.Path(item['target']).read_text()!=originals[item['target']] for item in host_records),1 if fail_after_first_write else 3)
    # A change to any host bundle must reject the entire rollback before restoring any file.
    last=pathlib.Path(host_records[-1]['target']);installed=last.read_text();last.write_text('operator change')
    unchanged={item['target']:pathlib.Path(item['target']).read_bytes() for item in manifest['files']}
    refused=run('--rollback',str(snapshot),'--apply');self.assertNotEqual(refused.returncode,0)
    self.assertEqual({name:pathlib.Path(name).read_bytes() for name in unchanged},unchanged)
    last.write_text(installed)
    restored=run('--rollback',str(snapshot),'--apply');self.assertEqual(restored.returncode,0,restored.stderr)
    for name,original in originals.items():self.assertEqual(pathlib.Path(name).read_text(),original)
if __name__=='__main__':unittest.main(verbosity=2)
