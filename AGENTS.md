# AGENTS.md — 中国人能教（AI 教师）项目规范

> 本文件是项目的"宪法"：任何 AI 工具（TRAE / WorkBuddy / Copilot 等）和开发者在修改本仓库前必须先读完并遵守。
> 修改边界：改动涉及下列约定时，先在任务卡提出，由负责人确认，不要静默更改。

## 1. 项目是什么

本地部署的多学科 AI 教师：拍照/输入题目 → 本地大模型识别与解答 → 出题与批改。
**全部推理在本地完成，不调用任何云端大模型 API。**

## 2. 架构与端口（改端口 = 改约定，需任务卡确认）

| 端口 | 服务 | 说明 |
| --- | --- | --- |
| 5173 | 前端 dev（Vite） | 生产模式由 8787 从 `dist/` 提供静态资源 |
| 8787 | 后端（Node, `server/index.mjs`） | 唯一对外入口 |
| 8080 | 视觉模型 llama.cpp | Qwen3-VL-4B-Instruct，`-ngl 99` |
| 8090 | 数学服务（`math_service/`） | Qwen2.5-Math-7B-Instruct，bf16 + CPU，按需懒加载 |
| 8100 | 科学模型 llama.cpp | Intern-S1-mini GGUF Q8_0，**固定 `-ngl 0`（纯 CPU）** |

- 模型分派逻辑集中在 `server/model-adapter.mjs` 的 `runVisionTask`。
- 模型权重在 `models/`，便携运行时在 `runtime/`（Node、llama.cpp、CUDA DLL、Python）。

## 3. 模型路由与回退（核心业务规则，不可违反）

- 视觉模型：默认兜底，负责识别、学科判断、语/数/英批改。
- 数学模型：仅"深度思考 + 数学"时调用；不可用时回退视觉模型。
- 科学模型：仅"深度思考 + 物理/化学/生物/地理"时调用；不可用时回退视觉模型。
- **回退必须静默**：服务冷却中/不可用/返回全空/调用失败，一律只返回视觉结果。
  不得向用户输出「已回退」「模型不可用」等任何提示文案；诊断信息只写服务端日志。
- 科学请求固定带 `chat_template_kwargs: { enable_thinking: false }`，并把视觉模型提取的
  题目原文（`problem` / `studentAnswer`）渲染进 prompt——只传字段清单会导致科学模型返回全空。
- "有响应但字段全空"由 `hasVisibleAnswer()` 判定并回退，**不允许出现空白答案卡**。
- 科学请求默认 240s 超时（`SCIENCE_MODEL_TIMEOUT_MS`），失败后熔断冷却 180s（`SCIENCE_COOLDOWN_MS`）。
- **视觉请求也必须有超时**（默认 180s，`VISION_MODEL_TIMEOUT_MS`）：llama.cpp 会「假死」——
  端口在听、`/health` 正常、请求被接受（`/slots` 里 `n_prompt_tokens` 有值但 `processed=0`）却永不返回。
  没有超时学生就只会看到一直转圈的加载态（表现为「没有输出」）。
- 视觉结果为空（照片没读清、证明题、图内无文字）时由 `ensureVisibleAnswer()` 兜底，
  给出「换一张更清楚的照片再试 / 可勾选深度思考」的提示，**不得出现模型名**。
- **数学服务的提示词必须显式要求中文输出**：Qwen2.5-Math-7B 训练语料偏英文，
  提示词里不写「一律使用简体中文作答」就会整篇用英文回答（`math_service/math_server.py`）。

## 4. UI 红线

- 界面上**不得出现任何"某情况调用某模型"的说明文字**（引擎提示、分流提示、结果页引擎徽章均已删除，勿恢复）。
- 「复制结果」剔除结果的 `mode` 字段。
- **例外**：左下角「本地模型」就绪状态面板（视觉/数学/科学三行绿点）必须保留，数据来自 `/api/health`。

## 5. 知识点库

- `server/knowledge-points.mjs`：小学 = 语文/数学/英语；初中/高中 = 语文/数学/英语/物理/化学/生物/地理。
  共 17 个 `stage:subject` 组合，≥170 个知识点。
- 前端出题界面的学科下拉框必须按学段联动：**小学不得出现物化地生**。

## 6. 常用命令

```powershell
# 后端测试（Node 内置测试器，当前 57 项）
node --test server/*.test.mjs

# 模型服务测试
python -m unittest discover -s . -p "test_*.py" -t .

# 前端构建（改了 client/ 后必须重建，生产模式后端从 dist 提供资源）
npm run build        # 即 vite build

# 启动（用户手动运行）
start-ai-teacher.bat
```

## 7. 本机开发陷阱（Windows）

- 所有 `.ps1` 脚本必须保存为 **UTF-8 带 BOM**，否则 PowerShell 5.1 按 GBK 解码中文注释会随机报语法错误。
- Python 统一走 `scripts/resolve-python.ps1` 的 `Resolve-PythonExe`：优先 `runtime\python\python.exe`（便携），
  系统默认 `python.exe` 解析到 WorkBuddy 托管 3.13（无 torch），不可用。
- 沙箱/自动化环境禁止 `Start-Process`、`schtasks`、`cmd.exe`；需要常驻服务让用户自己运行启动脚本。
- 内存预算：32 GB 物理内存、约 10 GB 被其他应用占用。视觉 1.6 GB + 科学 GGUF 8.5 GB + 数学 bf16 约 15 GB，
  **三个服务不要同时全开**。科学模型严禁开 GPU offload（8 GB 显卡余量不足，会"端口活着但推理永久挂起"）。

## 8. 数据与隐私

- 答题记录（客户端 IP、题目文本、模型调用记录、时间）存入本机 SQL Server（`AITeacherDB`），
  表结构见 `server/db.mjs`，设计目标：后续可整体迁移云端、按用户管理。
- `models/`、`runtime/`（约 41 GB 模型与便携运行时）**不入 Git**；仓库只含代码与文档。
- 前端截图、课件等个人材料不入库。

## 9. Git 约定

- `main` 分支为主干；每个可运行里程碑打 tag（如 `v0.1-三模型联通`）。
- 提交信息用中文一句话说清"改了什么、为什么"。
- 公共文件（本文件、README、package.json）的修改在任务卡中提出，避免多模块并行时冲突。
