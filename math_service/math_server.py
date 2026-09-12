import json
import os
import re
import threading
from pathlib import Path
from typing import Any

import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from transformers import AutoModelForCausalLM, AutoTokenizer


ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = Path(os.environ.get("MATH_MODEL_PATH", ROOT / "models" / "Qwen2.5-Math-7B-Instruct"))
MODEL_NAME = os.environ.get("MATH_MODEL_NAME", "Qwen2.5-Math-7B-Instruct")
MAX_NEW_TOKENS = int(os.environ.get("MATH_MAX_NEW_TOKENS", "2048"))
REQUIRED_FILES = (
    "config.json",
    "generation_config.json",
    "merges.txt",
    "model.safetensors.index.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "vocab.json",
)

app = FastAPI(title="AI Teacher Math Model")
_model = None
_tokenizer = None
_load_error = ""
_load_lock = threading.Lock()


class SolveRequest(BaseModel):
    kind: str = "solve"
    problem: str = ""
    studentAnswer: str = ""


class GenerateRequest(BaseModel):
    kind: str = "generate"
    stage: str = ""
    subject: str = "数学"
    knowledgePointName: str = ""
    questionType: str = "解答题"
    difficulty: str = "基础"


def missing_files() -> list[str]:
    return [name for name in REQUIRED_FILES if not (MODEL_DIR / name).is_file()]


def load_model() -> None:
    global _model, _tokenizer, _load_error
    if _model is not None:
        return
    with _load_lock:
        if _model is not None:
            return
        missing = missing_files()
        if missing:
            _load_error = "缺少模型文件：" + ", ".join(missing)
            raise RuntimeError(_load_error)
        try:
            _tokenizer = AutoTokenizer.from_pretrained(str(MODEL_DIR), local_files_only=True)
            _model = AutoModelForCausalLM.from_pretrained(
                str(MODEL_DIR),
                local_files_only=True,
                dtype=torch.bfloat16,
            )
            _model.eval()
            _load_error = ""
        except Exception as exc:
            _load_error = f"数学模型加载失败：{exc}"
            _model = None
            _tokenizer = None
            raise


def make_prompt(request: SolveRequest) -> str:
    student = request.studentAnswer or "（没有提供学生作答，只求解题目）"
    return f"""你是严谨的中学数学老师。请解答下面的数学问题，并仔细检查每一步计算。
First identify the domain and choose a short, rigorous, checkable analytic proof. For proof questions, prefer standard inequalities, monotonicity, and equivalent transformations. Do not replace a proof with finite-value testing, trial values, numerical search, approximate extrema, Lambert W, or numerical root finding. Finish every proof and state the conclusion explicitly.
For "prove e^x > ln x + 2", state x > 0 first, then use e^x > 1+x and ln x <= x-1 to derive e^x - ln x - 2 > 0. This requires a strict analytic proof, not trial values or a numerical minimum.
题目：
{request.problem}

学生作答：
{student}

请只返回一个简短 JSON 对象，不要输出 Markdown 代码块、推导之外的说明或重复题目。字段必须是：
answer（最终答案字符串）、steps（字符串数组，每步包含公式和理由）、keyIdeas（字符串数组）、knowledgePoints（字符串数组）、scorePercent（0 到 100 的数字）、verdict（批改结论）、mistakes（字符串数组）、suggestions（字符串数组）、problemText（题目原文）、studentAnswer（作答原文）。
如果没有学生作答，scorePercent 填 0，verdict 留空。所有公式可以使用 LaTeX。"""


def make_generate_prompt(request: GenerateRequest) -> str:
    return f"""你是严谨的中学数学老师。请生成一道{request.stage}数学{request.questionType}。
知识点：{request.knowledgePointName}
难度：{request.difficulty}

请只返回一个 JSON 对象，不要输出 Markdown 代码块。字段必须是：question、options（字符串数组）、referenceAnswer、explanation、knowledgePoints（字符串数组）。题目条件完整，答案唯一，公式可以使用 LaTeX。"""


def generate_text(prompt: str) -> str:
    load_model()
    messages = [{"role": "user", "content": prompt}]
    if hasattr(_tokenizer, "apply_chat_template"):
        inputs = _tokenizer.apply_chat_template(
            messages,
            add_generation_prompt=True,
            return_tensors="pt",
            return_dict=True,
        )
    else:
        inputs = _tokenizer(prompt, return_tensors="pt", return_attention_mask=True)
    if isinstance(inputs, torch.Tensor):
        input_ids = inputs
        attention_mask = None
    else:
        input_ids = inputs["input_ids"]
        attention_mask = inputs.get("attention_mask")
    generate_kwargs = {
        "max_new_tokens": MAX_NEW_TOKENS,
        "do_sample": False,
        "pad_token_id": _tokenizer.eos_token_id,
    }
    if attention_mask is not None:
        generate_kwargs["attention_mask"] = attention_mask
    with torch.inference_mode():
        output = _model.generate(
            input_ids,
            **generate_kwargs,
        )
    generated = output[0][input_ids.shape[-1] :]
    return _tokenizer.decode(generated, skip_special_tokens=True).strip()


def parse_json(text: str) -> dict[str, Any]:
    cleaned = re.sub(r"```(?:json)?|```", "", text, flags=re.IGNORECASE).strip()
    candidates = [cleaned]
    match = re.search(r"\{.*\}", cleaned, flags=re.DOTALL)
    if match:
        candidates.append(match.group(0))
    for candidate in candidates:
        try:
            value = json.loads(candidate)
            if isinstance(value, dict):
                return normalize_result(value)
        except json.JSONDecodeError:
            continue
    return normalize_result({"answer": text, "steps": [], "keyIdeas": [], "knowledgePoints": []})


def normalize_result(value: dict[str, Any]) -> dict[str, Any]:
    aliases = {
        "answer": ("answer", "finalAnswer", "final_answer", "答案"),
        "steps": ("steps", "solutionSteps", "solution_steps", "解题步骤"),
        "keyIdeas": ("keyIdeas", "keyideas", "key_ideas", "keyPoints", "keypoints", "关键思路"),
        "knowledgePoints": ("knowledgePoints", "knowledgepoints", "knowledge_points", "知识点"),
        "scorePercent": ("scorePercent", "score_percent", "score", "得分"),
        "verdict": ("verdict", "结论", "批改结论"),
        "mistakes": ("mistakes", "errors", "错误"),
        "suggestions": ("suggestions", "改进建议"),
        "problemText": ("problemText", "problem_text", "题目"),
        "studentAnswer": ("studentAnswer", "student_answer", "userAnswer", "学生作答"),
    }
    result = dict(value)
    for target, names in aliases.items():
        for name in names:
            candidate = value.get(name)
            if candidate is not None and (not isinstance(candidate, str) or candidate.strip()):
                result[target] = candidate
                break
    if not str(result.get("answer", "")).strip():
        for name in ("explanation", "analysis", "解析"):
            if str(value.get(name, "")).strip():
                result["answer"] = value[name]
                break
    return result


@app.get("/math/health")
def health() -> dict[str, Any]:
    missing = missing_files()
    return {
        "available": not missing,
        "ready": _model is not None,
        "model": MODEL_NAME,
        "device": "cpu",
        "missingFiles": missing,
        "error": _load_error,
    }


@app.post("/math/solve")
def solve(request: SolveRequest) -> dict[str, Any]:
    if not request.problem.strip():
        raise HTTPException(status_code=400, detail="数学题目为空。")
    try:
        result = parse_json(generate_text(make_prompt(request)))
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    result.setdefault("problemText", request.problem)
    result.setdefault("studentAnswer", request.studentAnswer)
    return {"result": {"mode": "math", **result}}


@app.post("/math/generate")
def generate(request: GenerateRequest) -> dict[str, Any]:
    try:
        result = parse_json(generate_text(make_generate_prompt(request)))
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"result": {"mode": "math", "kind": "generate", **result}}
