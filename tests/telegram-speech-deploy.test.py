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
if __name__=='__main__':unittest.main(verbosity=2)
