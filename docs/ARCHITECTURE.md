# AI 教师局域网版架构

## 目标

让手机只依赖个人热点连接电脑，不依赖公网、USB、ADB、MTP 或云端 API。

## 数据流

```text
手机 PWA
  ├─ POST /api/solve      -> 图片 + 教学指令
  ├─ POST /api/grade      -> 作答图片 + 批改指令
  ├─ POST /api/generate   -> 知识点 + 题型 + 难度
  └─ GET  /api/health     -> 服务与本地模型状态
              |
              v
电脑 Node.js 服务 :8787
  ├─ 网络层：监听 0.0.0.0，识别可用局域网地址
  ├─ 任务层：校验请求、统一返回结构、保存最近任务
  └─ 模型适配层：按学科与深度思考开关分派请求
              |
     ┌────────┼─────────────────────────┐
     v        v                         v
llama.cpp   Python 数学服务        科学服务 :8100
:8080       :8090                  ├─ llama.cpp + Intern-S1-mini Q8_0（默认）
Qwen3-VL    Qwen2.5-Math-7B        └─ 或 Python + bfloat16 完整权重（可选）
视觉识别     数学解题/命题           物理化学生物地理
```

## 模型策略

服务端统一通过 OpenAI 兼容接口调用三个本地模型，模型和运行时都可以在电脑端部署，后续更换其他开源模型而不改手机端协议。

| 模型 | 端口 | 职责 | 触发条件 |
| --- | --- | --- | --- |
| Qwen3-VL-4B-Instruct | 8080 | 图片识别、学科判断、题面提取，以及语文、英语的解答与批改 | 默认视觉识别；未勾选深度思考或识别为语文、英语 |
| Qwen2.5-Math-7B-Instruct | 8090 | 数学解题、批改与命题 | 勾选深度思考且学科为数学 |
| Intern-S1-mini | 8100 | 物理、化学、生物、地理的深度科学解题、批改与命题 | 勾选深度思考且学科为自然科学 |

分派规则集中在 `server/model-adapter.mjs` 的 `runVisionTask`：视觉模型先返回 `subject`，再按上表选择后续模型。任一专用模型不可用时，接口回退到视觉模型结果，保证流程不中断。

### 科学服务的两种部署形态

`scripts\start-science-server.ps1` 会先看 `models\Intern-S1-mini-GGUF`：

| 形态 | 生效条件 | 运行方式 | 权重占用 |
| --- | --- | --- | --- |
| Q8_0 GGUF（默认） | 目录内有 `.gguf` 且无 `.part` | `runtime\llama-server.exe`，`-ngl` 默认按可用显存自动计算 | 约 8.3 GB（Q8_0）+ 0.35 GB（mmproj） |
| bfloat16 完整权重 | 无 GGUF，且 `models\Intern-S1-mini` 有 `config.json` 且无 `.part` | Python + Transformers（`AutoProcessor` + `AutoModelForCausalLM`，`trust_remote_code`），按需懒加载 | 约 16 GB |

两种形态都提供 `/v1/models`、`/v1/chat/completions` 和 `/health`，因此业务后端完全不需要区分。`getScienceModelStatus()` 同时兼容 Python 服务的 `{"available": bool, "device": ...}` 和 llama.cpp 的 `{"status": "ok"}`：权重缺失、下载未完成或模型尚在加载时都判定为不可用，直接走视觉模型回退，不会白等一次生成。

GGUF 路径下模型走内存映射加载，显存足够时会自动把一部分 transformer 层放到 GPU；`runtime\ggml-cuda.dll` 缺少 `cudart64_12.dll` / `cublas64_12.dll` 时会退回纯 CPU（`scripts\fetch_cuda_runtime.py` 可补齐）。

### 推理模型的输出处理

Intern-S1-mini 的对话模板默认开启思维链，而本项目的题目/批改/命题都要求模型返回结构化 JSON。实测（本机 Q8_0、纯 CPU）：开着思考时 300 个 token 全部落在 `reasoning_content`，`content` 为空字符串、`finish_reason = length`，前端会拿到空结果；关闭思考后 3.6 秒即返回合法 JSON。

因此科学模型的请求统一带上 `chat_template_kwargs.enable_thinking = false`（见 `scienceRequestOptions()`），可用 `SCIENCE_ENABLE_THINKING=1` 覆盖。同时 `requestLocalChat` / `callLocalGenerate` 在 `content` 为空时会回退读取 `reasoning_content`，避免推理型模型任何情况下「答了但显示为空」。

命题结果的分段解析（`parseGeneratedText`）同时接受 `题目：`、`**题目**` 和 `【题目】` 三种标注形式，并保留片段内的 LaTeX（`\[ F = ma \]` 不会被当作方括号标记吃掉）。

## 命题知识点库

`server/knowledge-points.mjs` 内置小学、初中、高中三个学段的知识点清单。小学覆盖语文、数学、英语；初中和高中覆盖语文、数学、英语、物理、化学、生物、地理。前端出题界面的学科下拉框按学段联动，选定学科后只展示对应知识点。

## 连接策略

- 服务监听 `0.0.0.0:8787`，因此可被手机热点内的电脑 IP 访问。
- 地址发现通过 Node `os.networkInterfaces()`，过滤回环地址和常见隧道网段。
- UI 提供电脑端可访问地址与复制按钮。
- 手机端保存最后一次可用地址，启动时探测 `/api/health`。
- 任务请求使用 JSON data URL，首版避免引入 USB 协议或复杂文件传输层。

## MVP 边界

首版内置小学、初中、高中语文、数学、英语的主干知识点清单，并为初中和高中补齐物理、化学、生物、地理知识点，数据结构支持继续扩充为完整教材版本和地区版本。图片识别与批改由视觉语言模型完成，数学与自然科学分别由专用模型深入处理；未安装任一模型时使用演示适配器或回退到视觉结果，保证交互流程可验收。
