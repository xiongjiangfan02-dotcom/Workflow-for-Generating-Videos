"""Isolated Python 3.10 worker; stdout is reserved for JSON responses."""
import base64
import json
from pathlib import Path
import sys
import traceback

from megatts_voices import PRESETS, files

protocol = sys.stdout
sys.stdout = sys.stderr
ROOT = Path(__file__).resolve().parent
MODEL = ROOT.parents[1] / '.tools/MegaTTS3'
sys.path.insert(0, str(MODEL))
sys.argv = [sys.argv[0]]
model = None
contexts = {}

for line in sys.stdin:
    try:
        request = json.loads(line)
        preset = request['preset']
        if preset not in PRESETS:
            raise ValueError('Unknown voice preset')
        if model is None:
            import torch
            torch.set_num_threads(4)
            from tts.infer_cli import MegaTTS3DiTInfer
            device = 'cuda' if torch.cuda.is_available() else 'cpu'
            model = MegaTTS3DiTInfer(device=device, ckpt_root=str(MODEL / 'checkpoints'))
        if preset not in contexts:
            wav, latent = files(preset)
            with torch.inference_mode():
                context = model.preprocess(wav.read_bytes(), latent_file=str(latent))
            contexts[preset] = (context, model.loudness_prompt)
        context, model.loudness_prompt = contexts[preset]
        with torch.inference_mode():
            audio = model.forward(context, request['text'], time_step=32, p_w=1.6, t_w=2.5,
                                  dur_alpha=1 / (1 + request['rate'] * .08))
        reply = {'audio': base64.b64encode(audio).decode('ascii'), 'device': device}
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        reply = {'error': str(exc)[:700]}
    protocol.write(json.dumps(reply) + '\n')
    protocol.flush()
