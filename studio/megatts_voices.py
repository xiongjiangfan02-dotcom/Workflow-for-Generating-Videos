"""Fixed local MegaTTS3 voice catalog; requests never supply file paths."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT.parents[1] / '.tools' / 'MegaTTS3' / 'assets'
CUSTOM = ROOT.parent / '声音参考' / '2026-11-01_两角色参考' / '已验证音色'

PRESETS = {
    'megatts3-chinese': ('官方中文示例音色', 'zh-CN', ASSETS, 'Chinese_prompt'),
    'megatts3-english': ('官方英文示例音色', 'en-US', ASSETS, 'English_prompt'),
    'megatts3-voice-01': ('声音1（15:49录音）', 'zh-CN', CUSTOM, 'voice_01'),
    'megatts3-voice-02': ('声音2（15:48录音）', 'zh-CN', CUSTOM, 'voice_02'),
}


def files(name):
    _, _, directory, stem = PRESETS[name]
    return directory / (stem + '.wav'), directory / (stem + '.npy')


def voices():
    return [{'name': name, 'label': label, 'culture': culture}
            for name, (label, culture, _, _) in PRESETS.items()
            if all(path.is_file() for path in files(name))]
