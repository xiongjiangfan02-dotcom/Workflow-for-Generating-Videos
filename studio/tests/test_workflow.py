import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import wave

from PIL import Image

import core
import megatts_voices
import server


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory(prefix='expression-studio-test-')
        self.addCleanup(folder.cleanup)
        data = patch.object(core, 'DATA', Path(folder.name))
        data.start()
        self.addCleanup(data.stop)
        for name in ('projects', 'assets', 'jobs', 'audio', 'exports'):
            (core.DATA / name).mkdir()
        self.client = server.app.test_client()
        self.headers = {'X-Studio-Request': '1', 'Host': '127.0.0.1'}
        self.project = core.new_project(server.VOICES, '验收项目')
        self.project['roles'] = {'xiaoqi': '小七', 'ayuan': '阿圆'}
        self.project['voices'] = core.defaults(server.VOICES, self.project['roles'])
        self.project['segments'] = core.split_source('小七：别急。\n阿圆：我懂了！', self.project['roles'])

    def test_split_preserves_dialogue_and_roles(self):
        self.assertEqual([s['speaker'] for s in self.project['segments']], ['xiaoqi', 'ayuan'])
        self.assertEqual(''.join(s['text'] for s in self.project['segments']), '别急。我懂了！')
        self.assertEqual(self.project['segments'][1]['emotion'], 'realized')

    def test_missing_assets_blocks_render(self):
        response = self.client.post('/api/render', json={'project': self.project}, headers=self.headers)
        self.assertEqual(response.status_code, 400)
        self.assertIn('素材', response.json['error'])

    def test_speaker_and_display_are_independent(self):
        self.project['segments'][0]['display'] = 'ayuan'
        core.validate_project(self.project, server.VOICES)
        self.assertEqual(self.project['segments'][0]['speaker'], 'xiaoqi')

    def test_invalid_emphasis_and_pause_rejected(self):
        self.project['segments'][0]['emphasis'] = '不在原文'
        with self.assertRaises(ValueError):
            core.validate_project(self.project, server.VOICES)
        self.project['segments'][0]['emphasis'] = ''
        self.project['segments'][0]['pause_ms'] = -1
        with self.assertRaises(ValueError):
            core.validate_project(self.project, server.VOICES)

    def test_upload_and_matching(self):
        image = io.BytesIO()
        Image.new('RGBA', (120, 120), 'teal').save(image, format='PNG')
        image.seek(0)
        response = self.client.post('/api/assets', data={'file': (image, 'test.png'), 'role': 'xiaoqi', 'role_name': '小七', 'emotion': 'neutral', 'kind': 'character'}, headers=self.headers)
        self.assertEqual(response.status_code, 200)
        selected = core.choose_image(self.project['segments'][0])
        self.assertEqual(selected['id'], response.json['id'])
        self.project['segments'][1]['asset_id'] = selected['id']
        with self.assertRaises(ValueError):
            core.choose_image(self.project['segments'][1])

    def test_save_and_reload_excludes_key(self):
        self.project['api_key'] = 'never-save-this'
        core.save_project(self.project, server.VOICES)
        saved = core.load_project(self.project['id'])
        self.assertNotIn('api_key', saved)
        self.assertEqual(saved['segments'], self.project['segments'])

    def test_ai_invalid_coverage_rejected(self):
        response = type('Response', (), {'ok': True, 'json': lambda _: {'choices': [{'message': {'content': '{"segments":[]}'}}]}})()
        with patch('core.requests.post', return_value=response):
            with self.assertRaisesRegex(ValueError, '不完整'):
                core.analyze_ai(self.project['segments'], 'test', 'deepseek-chat')

    def test_origin_and_path_guards(self):
        response = self.client.post('/api/projects', json={}, headers={'Host': '127.0.0.1', 'X-Studio-Request': '1', 'Origin': 'https://unrelated.example'})
        self.assertEqual(response.status_code, 403)
        with self.assertRaises(ValueError):
            core.safe_id('../outside')

    def test_subtitle_rollover(self):
        self.assertEqual(core.subtitle_time(59.9996), '00:01:00,000')

    def test_arbitrary_roles_are_created_and_saved(self):
        result = self.client.post('/api/analyze', json={'source': '小云：你好！\n小山：原来如此。\n旁白：结束。', 'roles': {'narrator': '旁白'}}, headers=self.headers)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(set(result.json['roles'].values()), {'小云', '小山', '旁白'})
        self.project.update({k: result.json[k] for k in ('segments', 'roles', 'voices')})
        core.save_project(self.project, server.VOICES)
        self.assertEqual(core.load_project(self.project['id'])['roles'], self.project['roles'])

    def test_unknown_and_duplicate_roles_rejected(self):
        self.project['roles']['other'] = '小七'
        with self.assertRaisesRegex(ValueError, '重复'):
            core.validate_project(self.project, server.VOICES)
        del self.project['roles']['other']
        self.project['segments'][0]['speaker'] = 'missing'
        with self.assertRaisesRegex(ValueError, '角色列表'):
            core.validate_project(self.project, server.VOICES)

    def test_legacy_project_migrates_without_losing_segments(self):
        self.project.pop('schema_version')
        self.project.pop('roles')
        original = list(self.project['segments'])
        core.validate_project(self.project, server.VOICES)
        self.assertEqual(self.project['segments'], original)
        self.assertTrue(all(v['name'].startswith('megatts3-') for v in self.project['voices'].values()))
        self.assertNotIn('徒弟', self.project['roles'].values())

    def test_role_rename_preserves_asset_matching(self):
        self.project['roles']['xiaoqi'] = '新名字'
        core.validate_project(self.project, server.VOICES)
        self.assertEqual(self.project['segments'][0]['display'], 'xiaoqi')

    def test_megatts_unavailable_never_uses_system_speech(self):
        with patch('megatts.status', return_value={'ready': False}), patch('core.run') as command:
            with self.assertRaisesRegex(ValueError, '尚未就绪'):
                core.megatts.synthesize('测试。', 'megatts3-chinese', 0)
            command.assert_not_called()

    def test_verified_megatts_voices_exposed(self):
        self.assertEqual({v['name'] for v in server.VOICES},
                         {'megatts3-chinese', 'megatts3-english', 'megatts3-voice-01', 'megatts3-voice-02'})
        with patch.object(megatts_voices, 'PRESETS', {
                'missing': ('缺少文件', 'zh-CN', core.DATA, 'absent')}):
            self.assertEqual(megatts_voices.voices(), [])

    def test_custom_voice_selection_save_and_speech(self):
        for role, name in (('xiaoqi', 'megatts3-voice-01'), ('ayuan', 'megatts3-voice-02')):
            self.project['voices'][role]['name'] = name
        response = self.client.put('/api/projects/' + self.project['id'],
                                   json=self.project, headers=self.headers)
        self.assertEqual(response.status_code, 200)
        saved = self.client.get('/api/projects/' + self.project['id'], headers=self.headers).json
        self.assertEqual(saved['voices'], self.project['voices'])
        sample = io.BytesIO()
        with wave.open(sample, 'wb') as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(24000)
            audio.writeframes(b'\x01\x00' * 4800)

        def convert(command, timeout):
            Path(command[-1]).write_bytes(Path(command[command.index('-i') + 1]).read_bytes())

        with patch('megatts.synthesize', return_value=sample.getvalue()) as synthesize, \
                patch('core.run', side_effect=convert), \
                patch.object(core, 'find_ffmpeg', return_value='ffmpeg'):
            for index, name in enumerate(('megatts3-voice-01', 'megatts3-voice-02')):
                output = core.speech_audio(saved['segments'][index], saved['voices'])
                self.assertTrue(output.is_file())
                self.assertEqual(synthesize.call_args.args[1], name)

    def test_renamed_role_id_is_not_overwritten(self):
        roles = {'narrator': '旁白'}
        first = core.split_source('独有名字：你好。', roles)[0]['speaker']
        roles[first] = '已改名'
        second = core.split_source('独有名字：再见。', roles)[0]['speaker']
        self.assertNotEqual(first, second)
        self.assertEqual(roles[first], '已改名')

    def test_role_order_survives_api_roundtrip(self):
        self.project['roles'] = {'z_role': '第一角色', 'a_role': '第二角色'}
        self.project['voices'] = core.defaults(server.VOICES, self.project['roles'])
        self.project['segments'] = []
        core.save_project(self.project, server.VOICES)
        result = self.client.get('/api/projects/' + self.project['id'], headers=self.headers)
        self.assertEqual(list(result.json['roles']), ['z_role', 'a_role'])


if __name__ == '__main__':
    unittest.main()
