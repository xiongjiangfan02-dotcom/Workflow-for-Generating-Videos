import copy
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image
import core
import server


class AssetMutationTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix='studio-assets-test-')
        self.addCleanup(self.folder.cleanup)
        replacement = patch.object(core, 'DATA', Path(self.folder.name))
        replacement.start()
        self.addCleanup(replacement.stop)
        for name in ('projects', 'assets', 'jobs', 'audio', 'exports'):
            (core.DATA / name).mkdir()
        self.client = server.app.test_client()
        self.headers = {'Host': '127.0.0.1', 'X-Studio-Request': '1'}
        self.project = core.new_project(server.VOICES)
        self.project['roles']['other'] = '另一角色'
        self.project['voices'] = core.defaults(server.VOICES, self.project['roles'])
        self.project['segments'] = core.split_source('旁白：测试。', self.project['roles'])
        self.asset = self.upload('character')

    def upload(self, kind):
        stream = io.BytesIO()
        Image.new('RGB', (80, 100), 'teal').save(stream, format='PNG')
        stream.seek(0)
        result = self.client.post('/api/assets', data={'file': (stream, 'fixture.png'), 'kind': kind,
            'role': 'narrator', 'role_name': '旁白', 'emotion': 'neutral'}, headers=self.headers)
        self.assertEqual(result.status_code, 200)
        return result.json

    def edit(self, values):
        return self.client.put('/api/assets/' + self.asset['id'], json=values, headers=self.headers)

    def delete(self, asset=None):
        return self.client.delete('/api/assets/' + (asset or self.asset)['id'], headers=self.headers)

    def test_edit_name_and_emotion_preserves_file_and_id(self):
        content = core.asset_file(self.asset).read_bytes()
        self.assertEqual(core.choose_image(self.project['segments'][0])['id'], self.asset['id'])
        result = self.edit({'name': '新名字', 'emotion': 'happy'})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json['asset']['id'], self.asset['id'])
        self.assertEqual(core.get_asset(self.asset['id'])['emotion'], 'happy')
        self.assertIsNone(core.choose_image(self.project['segments'][0]))
        self.assertEqual(core.asset_file(self.asset).read_bytes(), content)

    def test_delete_repairs_projects_and_stale_autosaves(self):
        self.project['segments'][0]['asset_id'] = self.asset['id']
        core.save_project(self.project, server.VOICES)
        stale = copy.deepcopy(self.project)
        second = copy.deepcopy(self.project)
        second['id'] = core.uid()
        core.save_project(second, server.VOICES)
        self.assertEqual(self.delete().status_code, 200)
        self.assertEqual(core.catalog(), [])
        for project in (self.project, second):
            saved = core.read_json(core.DATA / 'projects' / (project['id'] + '.json'))
            self.assertEqual(saved['segments'][0]['asset_id'], '')
        self.upload('scene')
        saved = core.save_project(stale, server.VOICES)
        self.assertEqual(saved['segments'][0]['asset_id'], '')
        self.assertTrue(core.asset_file(self.asset).exists())
        with self.assertRaises(ValueError):
            core.get_asset(self.asset['id'])
        self.assertEqual(self.delete().status_code, 400)

    def test_role_edit_clears_only_incompatible_associations(self):
        self.project['segments'][0]['asset_id'] = self.asset['id']
        core.save_project(self.project, server.VOICES)
        result = self.edit({'role': 'other', 'role_name': '另一角色'})
        self.assertEqual(result.status_code, 200)
        saved = core.load_project(self.project['id'])
        self.assertEqual(saved['segments'][0]['display'], 'narrator')
        self.assertEqual(saved['segments'][0]['asset_id'], '')
        self.assertTrue(core.inspect_project(saved))

    def test_emotion_edit_keeps_explicit_selection(self):
        self.project['segments'][0]['asset_id'] = self.asset['id']
        core.save_project(self.project, server.VOICES)
        self.assertEqual(self.edit({'emotion': 'shocked'}).status_code, 200)
        self.assertEqual(core.load_project(self.project['id'])['segments'][0]['asset_id'], self.asset['id'])

    def test_invalid_updates_do_not_change_index(self):
        before = core.catalog()
        for values in ({'name': '  '}, {'emotion': 'invalid'}, {'role': '../bad', 'role_name': '错误'}):
            self.assertEqual(self.edit(values).status_code, 400)
            self.assertEqual(core.catalog(), before)

    def test_active_render_blocks_edit_and_delete(self):
        core.write_json(core.DATA / 'jobs' / (core.uid() + '.json'), {'state': 'running'})
        self.assertEqual(self.delete().status_code, 400)
        self.assertEqual(self.edit({'name': '不能修改'}).status_code, 400)
        self.assertEqual(core.get_asset(self.asset['id'])['name'], 'fixture')

    def test_scene_rename_and_delete(self):
        scene = self.upload('scene')
        self.project['segments'][0]['scene_id'] = scene['id']
        core.save_project(self.project, server.VOICES)
        result = self.client.put('/api/assets/' + scene['id'], json={'name': '场景新名称'}, headers=self.headers)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json['asset']['kind'], 'scene')
        self.assertEqual(self.delete(scene).status_code, 200)
        self.assertEqual(core.load_project(self.project['id'])['segments'][0]['scene_id'], '')
        self.assertEqual(len(core.catalog()), 1)

    def test_mutation_requires_local_request(self):
        self.assertEqual(self.client.delete('/api/assets/' + self.asset['id'], headers={'Host': '127.0.0.1'}).status_code, 403)

    def remove_role(self, role, replacement='', action='reassign', headers=None):
        return self.client.delete(f"/api/projects/{self.project['id']}/roles/{role}",
            json={'project': self.project, 'replacement': replacement, 'asset_action': action},
            headers=self.headers if headers is None else headers)

    def test_remove_empty_role_preserves_script_and_images(self):
        before = copy.deepcopy(self.project)
        result = self.remove_role('other')
        self.assertEqual(result.status_code, 200)
        self.assertNotIn('other', result.json['project']['roles'])
        self.assertNotIn('other', result.json['project']['voices'])
        self.assertEqual(result.json['project']['source'], before['source'])
        self.assertEqual(result.json['project']['segments'], before['segments'])
        self.assertEqual(result.json['assets'], [self.asset])
        self.assertNotIn('other', core.load_project(self.project['id'])['roles'])

    def test_remove_used_role_requires_valid_replacement_without_writes(self):
        core.save_project(self.project, server.VOICES)
        before = core.load_project(self.project['id'])
        for replacement in ('', 'narrator', 'missing'):
            self.assertEqual(self.remove_role('narrator', replacement).status_code, 400)
            self.assertEqual(core.load_project(self.project['id']), before)
            self.assertEqual(core.catalog(), [self.asset])

    def test_remove_role_transfers_images_and_repairs_shared_references(self):
        self.project['segments'][0].update(asset_id=self.asset['id'], audio_id=core.uid())
        core.save_project(self.project, server.VOICES)
        other = copy.deepcopy(self.project)
        other['id'] = core.uid()
        core.save_project(other, server.VOICES)
        result = self.remove_role('narrator', 'other')
        self.assertEqual(result.status_code, 200)
        current = result.json['project']
        self.assertNotIn('narrator', current['roles'])
        self.assertEqual(current['segments'][0]['speaker'], 'other')
        self.assertEqual(current['segments'][0]['display'], 'other')
        self.assertEqual(current['segments'][0]['audio_id'], '')
        self.assertEqual(current['segments'][0]['asset_id'], self.asset['id'])
        self.assertEqual(core.get_asset(self.asset['id'])['role'], 'other')
        self.assertTrue(core.asset_file(self.asset).exists())
        shared = core.load_project(other['id'])
        self.assertIn('narrator', shared['roles'])
        self.assertEqual(shared['segments'][0]['display'], 'narrator')
        self.assertEqual(shared['segments'][0]['asset_id'], '')

    def test_remove_role_soft_deletes_only_its_images(self):
        scene = self.upload('scene')
        self.project['segments'][0]['asset_id'] = self.asset['id']
        result = self.remove_role('narrator', 'other', 'delete')
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json['assets'], [scene])
        self.assertEqual(result.json['project']['segments'][0]['asset_id'], '')
        self.assertTrue(core.asset_file(self.asset).exists())
        self.assertEqual(result.json['project']['segments'][0]['text'], self.project['segments'][0]['text'])

    def test_last_role_and_active_render_cannot_be_deleted(self):
        del self.project['roles']['other']
        del self.project['voices']['other']
        self.assertEqual(self.remove_role('narrator', action='delete').status_code, 400)
        self.assertEqual(core.catalog(), [self.asset])
        self.project['roles']['other'] = '另一角色'
        self.project['voices'] = core.defaults(server.VOICES, self.project['roles'])
        core.write_json(core.DATA / 'jobs' / (core.uid() + '.json'), {'state': 'running'})
        self.assertEqual(self.remove_role('narrator', 'other', 'delete').status_code, 400)
        self.assertEqual(core.catalog(), [self.asset])

    def test_remove_library_only_role_keeps_project_roles(self):
        self.assertEqual(self.edit({'role': 'library', 'role_name': '素材角色'}).status_code, 200)
        result = self.remove_role('library', action='delete')
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json['project']['roles'], self.project['roles'])
        self.assertEqual(result.json['assets'], [])

    def test_role_removal_validates_request(self):
        self.assertEqual(self.remove_role('other', headers={'Host': '127.0.0.1'}).status_code, 403)
        self.assertEqual(self.remove_role('other', action='unknown').status_code, 400)
        self.assertEqual(self.remove_role('missing').status_code, 400)
        wrong = copy.deepcopy(self.project)
        wrong['id'] = core.uid()
        result = self.client.delete(f"/api/projects/{self.project['id']}/roles/other",
            json={'project': wrong, 'asset_action': 'delete'}, headers=self.headers)
        self.assertEqual(result.status_code, 400)
