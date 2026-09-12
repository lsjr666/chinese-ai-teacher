# 开源本地模型选择

项目使用三个开源本地模型协同工作，全部通过 OpenAI 兼容接口调用，不依赖闭源模型服务。

## 视觉与通用模型

`Qwen/Qwen3-VL-4B-Instruct-GGUF`

- 上游模型：[Qwen3-VL-4B-Instruct](https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct)
- GGUF：[Qwen3-VL-4B-Instruct-GGUF](https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF)
- 许可证：Apache-2.0
- 运行时：[llama.cpp](https://github.com/ggml-org/llama.cpp)
- 适用：中文题目识别、学科判断、图片问答、语文和英语解题讲解
- 当前随项目保留 Q4_K_M 主模型和 Q8_0 视觉投影文件

## 数学专用模型

`Qwen/Qwen2.5-Math-7B-Instruct`

- 模型：[Qwen2.5-Math-7B-Instruct](https://huggingface.co/Qwen/Qwen2.5-Math-7B-Instruct)
- 许可证：Apache-2.0
- 运行时：PyTorch + Transformers + FastAPI，服务代码在 `math_service/`
- 监听：`127.0.0.1:8090`
- 适用：勾选深度思考后的数学解题、批改与命题

## 深度科学模型

`Intern-S1-mini`

- 模型：[Intern-S1-mini](https://huggingface.co/internlm/Intern-S1-mini)（ModelScope：`Shanghai_AI_Laboratory/Intern-S1-mini`）
- GGUF：[Intern-S1-mini-GGUF](https://www.modelscope.cn/models/Shanghai_AI_Laboratory/Intern-S1-mini-GGUF)（本项目默认使用 `Q8_0` 主权重 + `Q8_0` mmproj）
- 许可证：Apache-2.0
- 架构：8B 语言模型（Qwen3，36 层）+ 视觉编码器（InternViT，24 层），InternVL 家族多模态推理模型
- 运行时（默认）：`llama.cpp`，与视觉模型共用 `runtime\llama-server.exe`，服务由 `scripts\start-science-server.ps1` 拉起
- 运行时（可选）：PyTorch + Transformers（`AutoProcessor` + `AutoModelForCausalLM`，`trust_remote_code`）+ FastAPI，服务代码在 `science_service/`，依赖 `transformers>=4.55.2`、`torch`、`Pillow`
- 监听：`127.0.0.1:8100`（两种运行方式都提供 OpenAI 兼容接口）
- 适用：勾选深度思考后，物理、化学、生物、地理的解题、批改与命题；对化学结构、材料、生命科学等任务有明显优势

### 为什么默认走 GGUF

完整权重是 bfloat16 的 8B 模型，权重本身就要约 16 GB 内存，而本项目面向的笔记本往往只有 32 GB 内存且被系统和其他程序占去一半。`Q8_0` GGUF 只有 8.3 GB，配合 `llama.cpp` 的内存映射加载，约 9 GB 内存即可跑起来，精度损失极小。少数显存/内存都充裕的机器可以直接用 `-Variant full` 下载原始权重，两条路径的接口与路由逻辑完全一致。

### 推理模式的取舍

Intern-S1-mini 支持思维链（thinking）。本项目的搜题、批改、命题都要求模型返回结构化 JSON，实测开着思考时全部 token 都会停在 `reasoning_content` 里、`content` 为空，因此请求显式关闭思考（`chat_template_kwargs.enable_thinking = false`）。8B 的学科专用模型即使在非思考模式下，物理/化学/生物/地理的解题质量仍明显优于 4B 的通用视觉模型。需要对比原始行为可设 `SCIENCE_ENABLE_THINKING=1`。

### CUDA 运行时

`runtime\` 里的 `ggml-cuda.dll` 会延迟加载 `cudart64_12.dll` 和 `cublas64_12.dll`，llama.cpp 的发布包并不附带这两个库，缺少时 llama.cpp 会报告 `Available devices: (none)` 并退回 CPU。`scripts\fetch_cuda_runtime.py` 从 PyPI 的 `nvidia-cuda-runtime-cu12` / `nvidia-cublas-cu12` 轮子里取出这两个 DLL 放进 `runtime\`，装好后即可在 `start-science-server.ps1` 里按可用显存自动分配 GPU 层数。

## OCR 补强

后续可以增加 [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) 作为独立 OCR 层。它是 Apache-2.0 项目，适合对整页试卷、手写区域和中文文字做预处理；视觉语言模型负责理解题意和教学表达。

## 本项目的开源边界

- 电脑端业务代码使用 Node.js 内置模块和开源前端依赖。
- 本地推理使用 llama.cpp、PyTorch 和 Transformers，不调用云端模型 API。
- 视觉模型使用公开 GGUF 权重，服务只监听电脑 `127.0.0.1:8080`；数学模型和科学模型只监听 `127.0.0.1:8090`、`127.0.0.1:8100`。
- 手机只访问电脑端业务 API `8787`，题目照片不会上传到公网。
