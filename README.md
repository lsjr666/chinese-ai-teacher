# 中国人能教

电脑端运行本地模型，手机通过个人热点访问电脑端服务。

## 首版能力

- 拍照搜题：手机拍照上传，电脑端本地模型返回答案、步骤、关键思路和知识点。
- 知识点命题：手机选择学段、学科、知识点、题型和难度，电脑端生成题目与参考答案。
- 拍照批改：手机上传作答照片，电脑端识别过程并返回得分百分比、判断、问题和改进建议。
- 本地模型适配：使用开源 `llama.cpp` 和 Qwen3-VL 视觉模型；未安装模型时自动使用演示适配器，方便先验收全流程。
- 多模型学科路由：图片先由 Qwen3-VL 识别学科与题面。勾选“深度思考”后，数学题交给本地 Qwen2.5-Math-7B-Instruct 解题与命题，物理、化学、生物、地理交给 Intern-S1-mini 深度科学模型；未勾选深度思考或识别为语文、英语时，始终由 Qwen3-VL 回答。
- 出题知识点库：覆盖小学、初中、高中三个学段，初中和高中包含语文、数学、英语、物理、化学、生物、地理共 7 个学科的知识点清单。
- 热点连接：电脑服务监听 `0.0.0.0:8787`，手机与电脑连接同一个手机热点即可访问。

## 启动

最简单的方式是双击项目根目录的 `start-ai-teacher.bat`。脚本会依次启动模型、电脑端服务和网页，并打开电脑端页面。

手机连接电脑开启的手机热点后，在手机浏览器打开：

```text
http://电脑热点IPv4地址:5173/
```

启动窗口会列出当前电脑的 IPv4 地址。使用热点网卡对应的地址，不要使用 `localhost`。

换电脑使用时，可以直接复制或压缩整个项目目录。解压后双击 `start-ai-teacher.bat` 即可；项目已包含可用的 Node.js 运行时，不依赖原电脑的 `D:\nodejs` 路径。首次启动若出现 Windows 防火墙提示，请允许专用网络访问。

项目目录中有一些未完成的模型分片和旧的参考目录，它们不会影响启动，但会明显增加压缩包体积；只保留完整模型文件可以减少传输时间。

也可以使用开发命令：

```powershell
npm install
npm run dev
```

电脑端访问 `http://127.0.0.1:5173`，手机端访问电脑热点 IP 对应的 `5173` 地址。

## 本地模型后端

首版默认使用开源 `llama.cpp` 运行时和 Apache-2.0 的 `Qwen3-VL-4B-Instruct-GGUF` 视觉模型，不需要云端 API 或闭源模型服务。

1. 从 [llama.cpp Releases](https://github.com/ggml-org/llama.cpp/releases) 下载 Windows CUDA 版本，将 `llama-server.exe` 放到 `runtime\llama-server.exe`。
2. 下载开源视觉模型文件：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\download-open-model.ps1
```

3. 启动开源视觉模型：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-llama-server.ps1
```

4. 另开一个终端启动电脑端业务后端：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-backend.ps1
```

数学模型服务需要 Python、PyTorch、Transformers、FastAPI 和 Uvicorn。若 `models\Qwen2.5-Math-7B-Instruct` 中只有权重分片，请先补齐配套文件：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\complete-math-model.ps1
```

然后启动数学模型服务：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-math-server.ps1
```

数学服务监听 `127.0.0.1:8090`，按需加载模型。当前 Python 为 CPU 版 PyTorch，首次加载 7B BF16 模型需要较多内存且推理速度较慢；数学服务不可用时，系统会保留 Qwen3-VL 结果。

## 深度科学模型 Intern-S1-mini

物理、化学、生物、地理在勾选「深度思考」后由 Intern-S1-mini 处理。它是 8B 多模态模型，有两种部署形态，本项目默认用第一种：

| 形态 | 下载体积 | 运行方式 | 内存需求 |
| --- | --- | --- | --- |
| **Q8_0 GGUF（默认）** | 约 8.7 GB | `llama.cpp`，与视觉模型共用同一个运行时 | 约 9 GB |
| bfloat16 完整权重 | 约 16 GB | Python + Transformers | 约 16 GB |

### 方式一：GGUF（推荐）

只下载 Q8_0 主权重和视觉投影 `mmproj` 两个文件：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\download-science-model.ps1 -Background
```

- 文件写入 `models\Intern-S1-mini-GGUF`，中断后可从断点续传。
- 进度：`.cache\download-gguf-progress.json`；日志：`.cache\download-science-gguf.log`。
- `-Background` 会注册计划任务 `AITeacherScienceDownload`，每 15 分钟自动续传一次，并且**直接调用 Python**，所以关掉终端、甚至重启电脑后仍会继续。同一时刻只有一个下载实例（靠 `.cache\download.lock` 互斥）。
- 下载完成后删除计划任务：`schtasks /delete /tn AITeacherScienceDownload /f`

下载器是项目自带的 `scripts\download_intern_mini.py`：纯标准库，直接用 HTTP Range 访问 ModelScope（国内直连，会自动跳过失效的系统代理），逐文件写入 `<文件名>.part`，**只有字节数校验通过才会改名成正式文件**，所以不会出现「看起来下完了其实是坏文件」的情况。缓存和日志都写在项目内的 `.cache\`，不占用系统盘。

不带 `-Background` 时它就在当前终端前台运行，中断后重新执行同一命令即可续传。

下载完成后启动科学模型服务：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-science-server.ps1
```

服务监听 `127.0.0.1:8100`，用 `llama.cpp` 提供与视觉模型一致的 OpenAI 兼容接口，业务后端无需任何改动。权重是内存映射加载的，第一个 token 需要几秒。

### 用显卡加速（可选）

`runtime\` 里的 `ggml-cuda.dll` 需要 `cudart64_12.dll` 和 `cublas64_12.dll`，llama.cpp 的发布包并不附带，所以默认只能跑 CPU。补上这两个 DLL 后即可使用显卡：

```powershell
python .\scripts\fetch_cuda_runtime.py
```

脚本从 PyPI 的 `nvidia-*` 轮子里取出这两个库放进 `runtime\`（依赖仅为标准库，可无人值守运行）。装好后确认：

```powershell
.\runtime\llama-server.exe --list-devices
```

能列出显卡后，`start-science-server.ps1` 会**自动**按当前可用显存把一部分层放到 GPU 上（8 GB 显存大约能放 20 层）。也可以手动指定：

```powershell
# 指定 GPU 层数；0 表示纯 CPU
powershell -ExecutionPolicy Bypass -File .\scripts\start-science-server.ps1 -GpuLayers 20 -ContextSize 8192
```

### 方式二：完整 bfloat16 权重

如果机器有 32 GB 以上内存（或可用的 CUDA 版 PyTorch），也可以直接跑原始权重：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\download-science-model.ps1 -Variant full -Background
```

下完后 `start-science-server.ps1` 会自动优先使用 GGUF；在没有 GGUF 时才回退到 Python 服务。也可显式控制加载方式：

| 场景 | 参数 | 权重占用 | 说明 |
| --- | --- | --- | --- |
| CPU | 默认 `-Device cpu`（bf16） | 约 16 GB 内存 | 需要 32 GB 内存的机器 |
| NVIDIA 显卡 | `-Device cuda -LoadIn4Bit` | 约 5 GB 显存 | 需要 CUDA 版 PyTorch 与 `bitsandbytes` |

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-science-server.ps1 -Device cuda -LoadIn4Bit
powershell -ExecutionPolicy Bypass -File .\scripts\start-science-server.ps1 -Device cpu -Dtype bfloat16
```

注意：CPU 路径绝不能使用 `float32`（需要约 32 GB 内存，会被系统杀掉），服务默认在 CPU 上使用 `bfloat16`。当前项目的 PyTorch 是 CPU 版（`torch==2.14.0+cpu`），要走这条路径的显卡加速需另外安装 CUDA 版 PyTorch 和 `bitsandbytes`——只想要显卡加速的话，用上面的 GGUF 方式更省事。

### 通用说明

只要权重没下完，`start-science-server.ps1` 会直接提示并退出（退出码 2），不会留下一个「起来了但一用就报错」的服务；一键启动脚本也会跳过它。服务不可用时，勾选深度思考的自然科学题目会自动回退到 Qwen3-VL 结果并在建议里说明，不会中断使用。

`start-science-server.ps1` 的选择顺序是：优先 GGUF，没有 GGUF 才回退到 bfloat16 完整权重。若走回退路径而可用内存明显不够，脚本会先打印警告并给出去下载 GGUF 的命令。

Intern-S1-mini 是推理模型，默认会先输出一长段思维链。本项目的题目/批改/命题都要求返回结构化 JSON，开着思考会把 token 全耗在思维链上、`content` 返回空，所以科学模型的请求都会带上 `chat_template_kwargs.enable_thinking = false`。想对比原始推理行为可以设 `SCIENCE_ENABLE_THINKING=1`（会明显变慢且 JSON 任务拿不到结果）。

`scripts\resolve-python.ps1` 会为所有 Python 模型服务挑选「真的装了依赖」的解释器；如果系统里 `python.exe` 指向了没有 torch 的解释器，脚本会自动改用其他已安装的 Python。

### 自检

三个引擎都起来之后，可以先跑一次自检，确认它们真的可用：

```powershell
npm run check:models
```

```text
OK    vision  Qwen3-VL-4B      http://127.0.0.1:8080/v1       Qwen3VL-4B-Instruct-Q4_K_M.gguf
FAIL  math    Qwen2.5-Math-7B  http://127.0.0.1:8090          fetch failed
OK    science Intern-S1-mini   http://127.0.0.1:8100/v1       Intern-S1-mini-Q8_0.gguf status=ok
```

（数学模型没启动时 `FAIL` 是正常的，接口会自动回退到视觉模型。）

想顺便验证科学模型真的能答题、并看它在本机的速度：

```powershell
$env:SCIENCE_CHECK_PROMPT = '一个质量 2 kg 的物体受 10 N 水平力、2 N 摩擦力，求加速度'
npm run check:models
```

在 24 核 i9 上纯 CPU 实测约 **7 tok/s**，一道物理题的完整解答约 30 秒。

模型文件下载完成后保存在 `models` 目录，之后可以断网运行。业务后端通过 `http://127.0.0.1:8080/v1` 的 OpenAI 兼容接口调用视觉模型，通过 `http://127.0.0.1:8090` 调用数学模型，通过 `http://127.0.0.1:8100/v1` 调用科学模型。

如果模型还没有安装，业务接口会自动进入演示模式，便于先验收接口和手机端流程。模型许可证和替代模型说明见 [docs/OPEN_SOURCE_MODEL.md](docs/OPEN_SOURCE_MODEL.md)。

## 迁移到另一台电脑（U 盘便携包）

整个项目是自包含的：Node.js（`runtime\node`）、llama.cpp 与 CUDA 运行库（`runtime`）、Python + torch/transformers（`runtime\python`）、全部模型权重都在项目文件夹内。在一台装好依赖的电脑上执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\make-portable.ps1 -Destination E:\AITeacher
```

脚本会把代码、运行时和模型（默认不含 16 GB 的 bfloat16 科学模型回退份，GGUF 是默认方案）拷到目标文件夹，并自动校验完整性。目标盘不能是 FAT32（单个模型文件超过 4 GB），请用 exFAT 或 NTFS。

在目标电脑上：打开文件夹，双击 `start-ai-teacher.bat` 即可，**无需安装 Node、Python、llama.cpp 或任何依赖**。要求：Windows 10/11 x64、约 28 GB 磁盘空间；16 GB 内存可跑视觉+科学，三模型全开建议 32 GB；有 NVIDIA 显卡且驱动较新时视觉/科学模型会自动用 GPU，纯 CPU 机器也能跑（科学模型换 CPU 版 llama-server 时需要替换 `runtime\` 内的二进制）。

## 参考项目

- [LocalMathOCR](https://github.com/xiaoyeTC/LocalMathOCR)
- [BookMind](https://github.com/Ksirailway-base/BookMind)
- [ai-study-hero](https://github.com/mangoyc/ai-study-hero)
- [GradeMate](https://github.com/luisfilipeap/GradeMate)
- [Qwen3-VL-4B-Instruct-GGUF](https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF)
- [Qwen2.5-Math-7B-Instruct](https://huggingface.co/Qwen/Qwen2.5-Math-7B-Instruct)
- [Intern-S1-mini](https://huggingface.co/internlm/Intern-S1-mini)
- [Intern-S1-mini-GGUF](https://www.modelscope.cn/models/Shanghai_AI_Laboratory/Intern-S1-mini-GGUF)
- [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR)
- [llama.cpp](https://github.com/ggml-org/llama.cpp)
