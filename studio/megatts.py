"""Local ByteDance MegaTTS3 bridge. Never falls back to another engine."""
import atexit
import base64
from array import array
import io
import json
import os
from pathlib import Path
import queue
import subprocess
import threading
import wave

from megatts_voices import voices

ROOT = Path(__file__).resolve().parent
TOOLS = ROOT.parents[1] / '.tools'
MODEL = TOOLS / 'MegaTTS3'
RUNTIME_ALIAS = Path(os.environ.get('LOCALAPPDATA', str(TOOLS))) / 'ExpressionStudio/megatts-runtime'
PYTHON = (RUNTIME_ALIAS if RUNTIME_ALIAS.exists() else TOOLS / 'megatts-env') / 'Scripts/python.exe'
VERIFIED = TOOLS / 'megatts-verified.json'
_process = None
_log = None
_idle = None
_responses = None
_lock = threading.RLock()


def status():
    files = ['aligner_lm/model_only_last.ckpt', 'diffusion_transformer/model_only_last.ckpt',
             'duration_lm/model_only_last.ckpt', 'g2p/model.safetensors', 'wavvae/decoder.ckpt']
    complete = PYTHON.exists() and all((MODEL / 'checkpoints' / f).exists() for f in files)
    ready = complete and VERIFIED.exists()
    return {'engine': 'MegaTTS3', 'vendor': 'ByteDance', 'ready': ready,
            'message': '本地配音就绪' if ready else '模型尚未完成安装与试音验证',
            'device': json.loads(VERIFIED.read_text('utf-8')).get('device', '') if ready else ''}


def close():
    global _process, _log, _idle
    with _lock:
        if _idle:
            _idle.cancel()
            _idle = None
        if _process:
            _process.terminate()
            try:
                _process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                _process.kill()
                _process.wait()
            _process = None
        if _log:
            _log.close()
            _log = None


def _read_responses(process, responses):
    try:
        for line in process.stdout:
            try:
                responses.put(json.loads(line))
            except json.JSONDecodeError:
                continue
    finally:
        responses.put({'error': '配音进程已退出，请检查 megatts-worker.log。'})


def synthesize(text, voice, rate, verify=False):
    global _process, _responses, _log, _idle
    if voice not in {item['name'] for item in voices()} or not text.strip() or len(text) > 160 or type(rate) is not int or not -5 <= rate <= 5:
        raise ValueError('MegaTTS3 配音参数无效。')
    if not verify and not status()['ready']:
        raise ValueError('MegaTTS3 尚未就绪，请完成模型安装；也可以先导入本句配音。')
    with _lock:
        if _idle:
            _idle.cancel()
        if _process is None or _process.poll() is not None:
            close()
            _log = (ROOT / 'megatts-worker.log').open('a', encoding='utf-8')
            env = {**os.environ, 'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8',
                   'HF_HUB_OFFLINE': '1', 'TOKENIZERS_PARALLELISM': 'false'}
            _process = subprocess.Popen([str(PYTHON), '-u', str(ROOT / 'megatts_worker.py')],
                cwd=MODEL, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=_log,
                encoding='utf-8', env=env, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            _responses = queue.Queue()
            threading.Thread(target=_read_responses, args=(_process, _responses), daemon=True).start()
        try:
            _process.stdin.write(json.dumps({'text': text, 'preset': voice, 'rate': rate}) + '\n')
            _process.stdin.flush()
            reply = _responses.get(timeout=900)
            if reply.get('error'):
                raise ValueError('MegaTTS3 配音失败：' + reply['error'])
            audio = base64.b64decode(reply['audio'], validate=True)
            if not audio.startswith(b'RIFF'):
                raise ValueError('MegaTTS3 未返回有效 WAV 音频。')
            with wave.open(io.BytesIO(audio), 'rb') as wav:
                if wav.getsampwidth() != 2 or wav.getnframes() < wav.getframerate() * .1:
                    raise ValueError('MegaTTS3 返回的音频过短或格式无效。')
                samples = array('h', wav.readframes(wav.getnframes()))
                if not samples or max(abs(value) for value in samples) < 20:
                    raise ValueError('MegaTTS3 返回了静音，请调整台词后重试。')
            if verify:
                VERIFIED.write_text(json.dumps({'device': reply['device'], 'engine': 'MegaTTS3'}), encoding='utf-8')
            return audio
        except (queue.Empty, BrokenPipeError, OSError) as exc:
            close()
            raise ValueError('MegaTTS3 响应超时或进程中断，请查看配音日志。') from exc
        except Exception:
            close()
            raise
        finally:
            if _process:
                _idle = threading.Timer(300, close)
                _idle.daemon = True
                _idle.start()


atexit.register(close)
