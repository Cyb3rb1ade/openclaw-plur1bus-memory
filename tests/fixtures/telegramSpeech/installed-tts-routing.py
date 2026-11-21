"""Import-only captured assertions; use telegram-speech-routing.test.py guarded fixtures."""
import os
from pathlib import Path
import unittest

WORKSPACES = ['workspace', 'workspace-bernhardine', 'workspace-heisenberg']
LUCY = 'el:KXxZd16DiBqt82nbarJx'


class TtsRoutingTest(unittest.TestCase):
    def setUp(self):
        raise RuntimeError('import-only reference: use the guarded routing adapter')

    def run_script(self, workspace, name, *args):
        raise RuntimeError('import-only reference: use the guarded routing adapter')

    def calls(self):
        raise RuntimeError('import-only reference: use the guarded routing adapter')

    def test_bilingual_keeps_lucy_for_german_and_polish(self):
        result = self.run_script('workspace-bernhardine', 'tts-bilingual.sh',
                                 'bernhardine', 'Guten Tag.', 'Dzień dobry.')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([c[1] for c in self.calls()], [LUCY, LUCY])
        for line in result.stdout.splitlines():
            self.assertGreater(Path(line.split(':', 1)[1]).stat().st_size, 0)
        self.assertEqual(len(result.stdout.splitlines()), 2)

    def test_conversion_failure_never_reports_success(self):
        fakebin = self.base / 'fakebin'
        fakebin.mkdir()
        ffmpeg = fakebin / 'ffmpeg'
        ffmpeg.write_text('#!/bin/sh\nexit 1\n')
        ffmpeg.chmod(0o755)
        self.env['PATH'] = str(fakebin) + ':' + os.environ['PATH']
        for ws, aid in zip(WORKSPACES, ['main', 'bernhardine', 'heisenberg']):
            with self.subTest(agent=aid):
                result = self.run_script(ws, 'tts-auto.sh', aid, 'Hallo.')
                self.assertNotIn('OK:', result.stdout)
                self.assertNotEqual(result.returncode, 0)

    def test_elevenlabs_failure_does_not_switch_to_german_piper(self):
        self.env['TEST_FAIL_GENERATION'] = 'true'
        result = self.run_script('workspace-bernhardine', 'tts-auto.sh',
                                 'bernhardine', 'Dzień dobry.')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual([c[1] for c in self.calls()], [LUCY])
        self.assertNotIn('OK:', result.stdout)
        self.assertTrue(result.stderr.strip())

    def test_bilingual_partial_failure_returns_error_with_valid_german_path(self):
        result = self.run_script('workspace-bernhardine', 'tts-bilingual.sh',
                                 'bernhardine', 'Hallo.', 'FAIL')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('OK_DE:', result.stdout)
        self.assertNotIn('OK_PL:', result.stdout)
        self.assertIn('ERR_PL:', result.stderr)

    def test_disabled_bilingual_makes_no_audio(self):
        self.env['TEST_ENABLED'] = 'false'
        result = self.run_script('workspace-bernhardine', 'tts-bilingual.sh',
                                 'bernhardine', 'Hallo.', 'Cześć.')
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')
        self.assertEqual(self.calls(), [])

    def test_mixed_text_is_one_request_with_selected_voice_and_unique_file(self):
        text = 'Guten Tag. Dzień dobry. Jetzt weiter po polsku.'
        paths = []
        for _ in range(2):
            result = self.run_script('workspace-bernhardine', 'tts-auto.sh',
                                     'bernhardine', text)
            self.assertEqual(result.returncode, 0, result.stderr)
            paths.append(result.stdout.strip().removeprefix('OK:'))
        self.assertEqual([c[:2] for c in self.calls()], [[text, LUCY], [text, LUCY]])
        self.assertNotEqual(*paths)
        self.assertTrue(all(Path(p).stat().st_size > 0 for p in paths))


if __name__ == '__main__':
    raise SystemExit('import-only reference: run tests/telegram-speech-routing.test.py')
