"""Run the installed six regression methods unchanged on our real isolated toolchain."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
import runpy
ROOT=Path(__file__).resolve().parent

def module(name,path):
 spec=importlib.util.spec_from_file_location(name,path);result=importlib.util.module_from_spec(spec);spec.loader.exec_module(result);return result
fixture=module('speech_fixture',ROOT/'telegram-speech-wrappers.test.py')
original=module('installed_cases',ROOT/'fixtures/telegramSpeech/installed-tts-routing.py')


class CapturedReferenceSafety(unittest.TestCase):
 def test_direct_entry_refuses_before_unittest_or_external_execution(self):
  with patch('unittest.main',side_effect=AssertionError('unsafe direct test runner reached')), patch('subprocess.run',side_effect=AssertionError('external execution forbidden')):
   with self.assertRaisesRegex(SystemExit,'import-only'):
    runpy.run_path(str(ROOT/'fixtures/telegramSpeech/installed-tts-routing.py'),run_name='__main__')
 def test_original_setup_refuses_before_any_live_fixture_access(self):
  with patch('tempfile.TemporaryDirectory',side_effect=AssertionError('unsafe live fixture setup reached')), patch('subprocess.run',side_effect=AssertionError('external execution forbidden')):
   with self.assertRaisesRegex(RuntimeError,'import-only'):
    original.TtsRoutingTest().setUp()

class InstalledRoutingCases(unittest.TestCase):
 manager=fixture.WrapperTests.manager
 set_enabled=fixture.WrapperTests.set_enabled
 def setUp(self):
  fixture.WrapperTests.setUp(self)  # Includes fail-fast live-path guard before any command.
  for agent in ['main','bernhardine','heisenberg']:
   result=self.manager(agent,'set-voice',agent,original.LUCY);self.assertEqual(result.returncode,0,result.stderr)
 def run_script(self,workspace,name,agent,*args):
  expected={'workspace':'main','workspace-bernhardine':'bernhardine','workspace-heisenberg':'heisenberg'}[workspace]
  self.assertEqual(agent,expected)
  if self.env.get('TEST_ENABLED')=='false':self.set_enabled(False)
  if self.env.get('TEST_FAIL_GENERATION')=='true':self.env['FAIL_SYNTH']='1'
  return fixture.WrapperTests.run_script(self,agent,name,*args)
 def calls(self):
  return [[c['body']['text'],'el:'+c['url'].split('/text-to-speech/',1)[1].split('?',1)[0]] for c in fixture.WrapperTests.calls(self)]

# Reuse exact original assertions and test bodies; only fixture/API adapters above change.
for name in dir(original.TtsRoutingTest):
 if name.startswith('test_'):setattr(InstalledRoutingCases,name,getattr(original.TtsRoutingTest,name))
if __name__=='__main__':unittest.main(verbosity=2)
