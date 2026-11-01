# MegaTTS3 本地接入记录

## 来源与位置

- 官方源码：`https://github.com/bytedance/MegaTTS3`
- 本次源码提交：`67395f2d590b48eea88f7f834469da333f48a161`
- 官方权重：`https://huggingface.co/ByteDance/MegaTTS3`
- 下载通道：`https://hf-mirror.com/ByteDance/MegaTTS3`，大文件按上游 LFS SHA256 校验。
- 安装位置：`D:\ai漫剧\.tools\MegaTTS3`
- 独立环境：`D:\ai漫剧\.tools\megatts-env`，Python 3.10.22。
- PyTorch：2.6.0，CUDA 12.6 wheel；依赖见 `megatts-requirements.txt`。
- 官方的 Chinese_prompt / English_prompt WAV 和 NPY 保留在源码的 assets 目录。

## Windows 兼容改动

官方示例使用 WeTextProcessing / Pynini。此处使用 `wetext==0.2.1` 运行同一项目编译的 WFST 规则，避免在 Windows 编译 Pynini。仍会把数字、日期等转换为读法，不是原样跳过文字标准化。

`openai-whisper==20240930` 的构建依赖需要 `pkg_resources`，因此构建工具限制为 `setuptools<81`，见 `megatts-build-constraints.txt`。使用 uv 重装时增加 `--build-constraint megatts-build-constraints.txt`。

本机目录名称包含中文，kaldifst 的 Windows 原生文件读取不支持该路径。因此在 `%LOCALAPPDATA%\ExpressionStudio\megatts-runtime` 创建指向独立环境的目录联接，工作台通过此纯英文路径启动配音 Python。联接不复制模型或环境，不改变原文件位置；移机时需要重新建立。

源码内将 `tts/infer_cli.py` 的两处 Normalizer 导入改为新增的 `tts/text_normalizer_windows.py`。此适配器保留中英文选择、儿化与语气词选项；`overwrite_cache` 在预编译规则运行库中不适用。

`tts/utils/audio_utils/io.py` 对带有 RIFF/WAVE 文件头的参考音频明确指定 WAV 格式，由 pydub 原生读取，避免对已知 WAV 再调用未安装的 ffprobe。其他输入保留原来的探测逻辑。本工作台只向模型提供官方 WAV 参考音频。

## 工作台调用

`megatts.py` 启动独立环境中的 `megatts_worker.py`，通过进程管道收发 JSON，未开放额外网络端口。官方模型的推理输出交给 FFmpeg 统一为单声道、24 kHz、PCM16。

首次使用延迟加载模型。句间复用模型及音色上下文，分别保存每个音色的响度基准，闲置五分钟后退出配音进程以释放资源。配音由独立锁串行执行。缓存标识包含引擎、音色、台词、语速，旧系统配音缓存不会混用。

只有真实试音成功后才写入 `.tools/megatts-verified.json`。未就绪或推理失败时返回明确错误，不会退回 Windows TTS。该标记是本机运行验证记录，不是模型训练文件。

## 限制

这不是抖音客户端的云端音色接口，也不包含剪映音色库。官方未提供 WaveVAE 声音编码器，普通 WAV 不能直接作为克隆音色使用。工作台除官方示例音色外，还会读取 `声音参考/2026-11-01_两角色参考/已验证音色` 中固定的两组 WAV＋NPY 配对文件；缺少配对文件的音色不会出现在列表中。用户上传的逐句录音仍可直接进入视频合成。

## 重装

先恢复上述官方源码、权重和 Windows 兼容改动，再创建 Python 3.10 独立环境。先从 PyTorch 官方 cu126 索引安装 `torch==2.6.0` 和 `torchaudio==2.6.0`，再在同一环境安装 `megatts-requirements.txt`。运行真实试音验证后才能启用。

工作台本身继续使用原来的 Python，不要把这些模型依赖安装到工作台主环境。`megatts-worker.log` 保存模型加载和推理错误，不包含在线账户密钥。
