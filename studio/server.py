from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import io
import json
from pathlib import Path
import threading
import time

from flask import Flask, jsonify, request, send_file, send_from_directory
from PIL import Image, ImageOps, UnidentifiedImageError
from werkzeug.exceptions import HTTPException

import core

app = Flask(__name__, static_folder=None)
app.json.sort_keys = False
app.config['MAX_CONTENT_LENGTH'] = 40 * 1024 * 1024
EXECUTOR = ThreadPoolExecutor(max_workers=1)
VOICES = []
VOICE_ERROR = ''
try:
    VOICES = core.get_voices()
except Exception:
    VOICE_ERROR = '无法读取本机声音，可先导入逐句配音。'


@app.before_request
def local_only():
    host = request.host.split(':')[0]
    if host not in ('127.0.0.1', 'localhost', '[::1]'):
        return jsonify(error='仅支持本机访问。'), 403
    if request.method in ('POST', 'PUT', 'DELETE'):
        origin = request.headers.get('Origin')
        if origin and origin not in (f'http://{request.host}', 'http://127.0.0.1:5173'):
            return jsonify(error='请求来源不被允许。'), 403
        if request.headers.get('X-Studio-Request') != '1':
            return jsonify(error='请求缺少本地工作台标记。'), 403


@app.errorhandler(Exception)
def error_handler(exc):
    if isinstance(exc, HTTPException):
        return jsonify(error=exc.description), exc.code
    if isinstance(exc, (ValueError, KeyError, TypeError, UnidentifiedImageError)):
        return jsonify(error=str(exc)), 400
    app.logger.exception('Local studio operation failed')
    return jsonify(error='处理未完成，请检查本地运行日志。'), 500


@app.get('/api/status')
def status():
    try:
        core.find_ffmpeg()
        ffmpeg = True
    except ValueError:
        ffmpeg = False
    return jsonify(app='expression-studio', voices=VOICES, voice_error=VOICE_ERROR, tts=core.megatts.status(), ffmpeg=ffmpeg,
                   emotions=core.EMOTIONS, roles=core.ROLES, motions=core.MOTIONS)


@app.get('/api/projects')
def projects():
    values = [core.read_json(p) for p in (core.DATA / 'projects').glob('*.json')]
    return jsonify(sorted([{'id': p['id'], 'name': p['name'], 'updated_at': p['updated_at'], 'count': len(p['segments'])} for p in values], key=lambda p: p['updated_at'], reverse=True))


@app.post('/api/projects')
def create_project():
    return jsonify(core.new_project(VOICES, request.json.get('name') or '未命名短剧'))


@app.route('/api/projects/<project_id>', methods=['GET', 'PUT'])
def project(project_id):
    if request.method == 'GET':
        return jsonify(core.load_project(project_id))
    core.load_project(project_id)
    value = request.json
    if value.get('id') != project_id:
        raise ValueError('项目编号不匹配。')
    return jsonify(core.save_project(value, VOICES))


@app.post('/api/analyze')
def analyze():
    body = request.json
    roles = dict(core.validate_roles(body.get('roles', dict(core.ROLES))))
    segments = core.split_source(body.get('source'), roles)
    mode = body.get('mode', 'local')
    if mode == 'deepseek':
        segments = core.analyze_ai(segments, body.get('api_key', ''), body.get('model', 'deepseek-chat'), roles)
    elif mode != 'local':
        raise ValueError('分析模式无效。')
    probe = {'id': core.uid(), 'name': '校验', 'source': body['source'], 'segments': segments,
             'voices': core.defaults(VOICES, roles), 'roles': roles, 'schema_version': 2, 'caption_color': '#f9d66b'}
    core.validate_project(probe, VOICES)
    return jsonify(segments=segments, mode=mode, roles=roles, voices=probe['voices'])


@app.delete('/api/projects/<project_id>/roles/<role>')
def delete_role(project_id, role):
    core.load_project(project_id)
    body = request.get_json()
    project = body['project']
    if project.get('id') != project_id:
        raise ValueError('项目编号不匹配。')
    return jsonify(core.remove_role(project, role, body.get('replacement', ''), body.get('asset_action'), VOICES))


@app.route('/api/assets', methods=['GET', 'POST'])
def assets():
    if request.method == 'GET':
        return jsonify(core.catalog())
    upload = request.files.get('file')
    if not upload or not upload.filename:
        raise ValueError('请选择文件。')
    kind = request.form.get('kind', 'character')
    role = request.form.get('role', 'narrator')
    role_name = request.form.get('role_name', '角色')
    emotion = request.form.get('emotion', 'neutral')
    if kind == 'character':
        core.validate_roles({role: role_name})
    if kind not in ('character', 'scene', 'audio') or emotion not in core.EMOTIONS:
        raise ValueError('素材类型、人物或表情无效。')
    asset = {'id': core.uid(), 'kind': kind, 'role': role, 'role_name': role_name, 'emotion': emotion,
             'name': Path(upload.filename).stem[:100], 'created_at': time.time()}
    output = core.asset_file(asset)
    if kind == 'audio':
        incoming = output.with_suffix('.upload')
        upload.save(incoming)
        try:
            core.run([core.find_ffmpeg(), '-hide_banner', '-loglevel', 'error', '-y', '-i', incoming,
                      '-t', '180', '-vn', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', output], 90)
            duration = core.wav_duration(output)
            if duration <= 0 or duration >= 180:
                raise ValueError('请导入单句音频，时长需小于180秒。')
            asset['duration'] = duration
        except Exception:
            output.unlink(missing_ok=True)
            raise
        finally:
            incoming.unlink(missing_ok=True)
    else:
        with Image.open(upload.stream) as source:
            if source.width * source.height > 30000000:
                raise ValueError('图片超过3000万像素，请缩小后导入。')
            image = ImageOps.exif_transpose(source).convert('RGBA')
            image.thumbnail((2400, 2400))
            image.save(output)
            asset.update(width=image.width, height=image.height)
    asset['url'] = '/media/assets/' + output.name
    return jsonify(core.add_asset(asset))


@app.route('/api/assets/<asset_id>', methods=['PUT', 'DELETE'])
def update_asset(asset_id):
    return jsonify(core.change_asset(asset_id, request.get_json(silent=True), delete=request.method == 'DELETE'))


@app.post('/api/check')
def check():
    value = core.validate_project(request.json, VOICES)
    return jsonify(issues=core.inspect_project(value))


@app.post('/api/frame')
def frame():
    value = core.validate_project(request.json['project'], VOICES)
    index = int(request.json.get('index', 0))
    if not 0 <= index < len(value['segments']):
        raise ValueError('请先选择一句台词。')
    art, caption = core.compose_layers(value['segments'][index], 540, 960, value['caption_color'], allow_missing=True, roles=value['roles'])
    buffer = io.BytesIO()
    Image.alpha_composite(art, caption).convert('RGB').save(buffer, format='JPEG', quality=88)
    buffer.seek(0)
    return send_file(buffer, mimetype='image/jpeg')


def job_update(job_id, **values):
    with core.LOCK:
        path = core.DATA / 'jobs' / (job_id + '.json')
        job = core.read_json(path)
        job.update(values)
        core.write_json(path, job)
        return job


def get_job(job_id):
    value = core.read_json(core.DATA / 'jobs' / (core.safe_id(job_id) + '.json'))
    if not value:
        raise ValueError('任务不存在。')
    return value


def execute_job(job_id, project, quality):
    try:
        if get_job(job_id).get('cancel_requested'):
            raise InterruptedError('已取消。')
        job_update(job_id, state='running', message='开始处理')
        result = core.make_video(project, job_id, quality,
                                 lambda progress, message: job_update(job_id, progress=progress, message=message),
                                 lambda: get_job(job_id).get('cancel_requested', False))
        job_update(job_id, state='done', progress=100, message='导出完成', result=result, finished_at=time.time())
    except InterruptedError as exc:
        job_update(job_id, state='cancelled', message=str(exc))
    except Exception as exc:
        job_update(job_id, state='failed', message=str(exc)[:2000])


@app.post('/api/render')
def render():
    value = core.validate_project(request.json['project'], VOICES)
    if not value['segments']:
        raise ValueError('请先添加台词。')
    if core.inspect_project(value):
        raise ValueError('表情或场景素材尚未齐全，请先处理素材检查中的缺项。')
    if any(not s.get('audio_id') for s in value['segments']) and not core.megatts.status()['ready']:
        raise ValueError('MegaTTS3 尚未就绪，请完成模型安装或导入逐句配音。')
    quality = request.json.get('quality', 'preview')
    if quality not in ('preview', 'full'):
        raise ValueError('导出规格无效。')
    core.find_ffmpeg()
    with core.LOCK:
        # Recheck after acquiring the same lock used by asset edits/deletion.
        core.repair_asset_references(value)
        if core.inspect_project(value):
            raise ValueError('素材已发生变化，请重新检查缺失项。')
        active = [core.read_json(p) for p in (core.DATA / 'jobs').glob('*.json')]
        if any(j['state'] in ('queued', 'running') for j in active):
            raise ValueError('已有任务正在处理，请等待完成后再导出。')
        job_id = core.uid()
        job = {'id': job_id, 'project_id': value['id'], 'name': value['name'], 'state': 'queued', 'quality': quality,
               'progress': 0, 'message': '等待处理', 'created_at': time.time(), 'cancel_requested': False}
        core.write_json(core.DATA / 'jobs' / (job_id + '.json'), job)
    EXECUTOR.submit(execute_job, job_id, json.loads(json.dumps(value)), quality)
    return jsonify(job)


@app.route('/api/jobs/<job_id>', methods=['GET', 'POST'])
def job(job_id):
    value = get_job(job_id)
    if request.method == 'POST' and value['state'] in ('queued', 'running'):
        value = job_update(job_id, cancel_requested=True, message='当前句处理完后停止')
    return jsonify(value)


@app.get('/api/projects/<project_id>/jobs')
def jobs(project_id):
    core.safe_id(project_id)
    values = [core.read_json(p) for p in (core.DATA / 'jobs').glob('*.json')]
    return jsonify(sorted([j for j in values if j['project_id'] == project_id], key=lambda j: j['created_at'], reverse=True))


@app.post('/api/speech')
def speech():
    value = core.validate_project(request.json['project'], VOICES)
    index = int(request.json['index'])
    if not 0 <= index < len(value['segments']):
        raise ValueError('请选择台词。')
    path = core.speech_audio(value['segments'][index], value['voices'])
    return send_file(path, mimetype='audio/wav', conditional=True)


@app.get('/media/<path:name>')
def media(name):
    parts = Path(name).parts
    if not parts or parts[0] not in ('assets', 'exports'):
        raise ValueError('文件不可访问。')
    resolved = (core.DATA / name).resolve()
    if not resolved.is_relative_to(core.DATA) or resolved.suffix.lower() not in ('.png', '.jpg', '.wav', '.mp4', '.srt', '.json'):
        raise ValueError('文件不可访问。')
    return send_from_directory(core.DATA, name, conditional=True)


@app.get('/')
@app.get('/<path:path>')
def frontend(path='index.html'):
    if path == 'favicon.ico':
        return '', 204
    return send_from_directory(core.ROOT / 'dist', path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8768)
    args = parser.parse_args()
    for path in (core.DATA / 'jobs').glob('*.json'):
        value = core.read_json(path)
        if value['state'] in ('queued', 'running'):
            job_update(value['id'], state='failed', message='上次运行已中断，可重新导出；已完成配音会复用。')
    app.run(host='127.0.0.1', port=args.port, debug=False, threaded=True)


if __name__ == '__main__':
    main()
