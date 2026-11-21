import importlib.util, io, json, os, pathlib, subprocess, tempfile, unittest
from unittest.mock import patch
ROOT=pathlib.Path(__file__).resolve().parents[1]
SPEC=importlib.util.spec_from_file_location('tts',ROOT/'scripts/telegramTts/elevenlabs-tts.py')
helper=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(helper)
class PreparedTests(unittest.TestCase):
 def test_exact_unicode_payload_not_reclipped(self):
  text='🐈 '*999+'…'
  with tempfile.TemporaryDirectory() as d, patch.object(helper,'_request',return_value=b'x'*1000) as req:
   helper.say_prepared({'version':1,'text':text,'speech':'[warm]'+text},'el-otto','eleven_v4',d+'/x.mp3')
   self.assertEqual(req.call_args.args[1]['text'],'[warm]'+text)
 def test_reject_word_changes_raw_tags_and_unknown_tags(self):
  for text,speech in [('Hallo','[warm]Anders'),('[laughs]Hallo','[laughs]Hallo'),('Hallo','[evil]Hallo'),('Hallo','[warm]'*65+'Hallo')]:
   with self.subTest(speech=speech),patch.object(helper,'_request') as req:
    with self.assertRaises((ValueError,SystemExit)): helper.say_prepared({'version':1,'text':text,'speech':speech},'el-otto','eleven_v4','/tmp/unused.mp3')
    req.assert_not_called()
 def test_provider_and_conversion_failures_do_not_advertise_output(self):
  with tempfile.TemporaryDirectory() as d, patch.object(helper,'_request',return_value=b'x'*1000),patch.object(helper.subprocess,'run',return_value=subprocess.CompletedProcess([],1,'','failed')):
   with self.assertRaises(SystemExit): helper.say_prepared({'version':1,'text':'Hallo','speech':'Hallo'},'el-otto','eleven_v4',d+'/out.ogg')
   self.assertFalse(pathlib.Path(d+'/out.ogg').exists())
if __name__=='__main__':unittest.main(verbosity=2)
