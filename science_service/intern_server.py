"""Local OpenAI-compatible service for the Intern-S1-mini deep science model.

The AI Teacher backend talks to this service through the same OpenAI-compatible
schema used for llama.cpp: it calls ``GET /v1/models`` to detect availability and
``POST /v1/chat/completions`` to run solve/grade/generate tasks.

Intern-S1-mini is an InternVL-family multimodal reasoning model (Qwen3-8B language
model + 0.3B InternViT vision encoder). The official recipe uses
``AutoProcessor`` + ``AutoModelForCausalLM`` with ``apply_chat_template``, so that
is the primary path here; a ``model.chat`` path is kept as a fallback for
InternVL-style checkpoints. Weights are loaded lazily on the first request so the
service starts instantly and stays idle when the science path is not used.
"""

from __future__ import annotations

import base64
import binascii
import io
import os
import re
import shutil
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel


ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = Path(os.environ.get("SCIENCE_MODEL_PATH", ROOT / "models" / "Intern-S1-mini"))
MODEL_NAME = os.environ.get("SCIENCE_MODEL_NAME", "Intern-S1-mini")
MAX_NEW_TOKENS = int(os.environ.get("SCIENCE_MAX_NEW_TOKENS", "2048"))
MAX_IMAGES = int(os.environ.get("SCIENCE_MAX_IMAGES", "3"))
REQUIRED_FILES = ("config.json", "tokenizer_config.json")

# ---------------- runtime placement ----------------
# Intern-S1-mini is an 8B model: bf16 weights need ~16 GB, fp32 needs ~32 GB.
# The CPU fallback therefore must NOT use fp32 (see _resolve_dtype), otherwise
# the process is killed by the OS on a typical 32 GB machine.
#
#   SCIENCE_DEVICE      auto | cpu | cuda      (default auto)
#   SCIENCE_DTYPE       auto | bfloat16 | float16 | float32   (default auto)
#   SCIENCE_LOAD_IN_4BIT  1 to force 4-bit NF4 (CUDA only, ~5 GB VRAM)
CPU_MAX_NEW_TOKENS = MAX_NEW_TOKENS

app = FastAPI(title="AI Teacher Science Model")

_model = None
_processor = None
_device = "cpu"
_dtype = None
_quantized = False
_load_error = ""
_load_lock = threading.Lock()

_DATA_URL_RE = re.compile(r"^data:(?P<mime>[^;]+);base64,(?P<data>.+)$", re.DOTALL)


class ChatRequest(BaseModel):
    model: str = MODEL_NAME
    messages: list[dict[str, Any]] = []
    stream: bool = False
    temperature: float = 0.2
    max_tokens: int | None = None
    max_new_tokens: int | None = None


def missing_files() -> list[str]:
    return [name for name in REQUIRED_FILES if not (MODEL_DIR / name).is_file()]


def _resolve_device(torch) -> str:
    """Pick cuda when usable, otherwise fall back to cpu."""

    preference = os.environ.get("SCIENCE_DEVICE", "auto").strip().lower()
    if preference == "cpu":
        return "cpu"
    if torch.cuda.is_available():
        return "cuda"
    if preference == "cuda":
        # Explicitly requested but unusable: surface it instead of silently slowing down.
        raise RuntimeError(
            "SCIENCE_DEVICE=cuda 但当前 PyTorch 没有可用的 CUDA（torch 可能是 CPU 版本）。"
        )
    return "cpu"


def _resolve_dtype(torch, device: str):
    """Choose a dtype that fits the available memory.

    CPU bf16 keeps an 8B checkpoint at ~16 GB. fp16 is not used on CPU because
    PyTorch CPU support for it is partial.
    """

    requested = os.environ.get("SCIENCE_DTYPE", "auto").strip().lower()
    table = {
        "bfloat16": torch.bfloat16,
        "bf16": torch.bfloat16,
        "float16": torch.float16,
        "fp16": torch.float16,
        "float32": torch.float32,
        "fp32": torch.float32,
    }
    if requested in table:
        return table[requested]
    return torch.float16 if device == "cuda" else torch.bfloat16


def _cuda_vram_gb(torch) -> float:
    try:
        free, _total = torch.cuda.mem_get_info()
        return free / (1024 ** 3)
    except Exception:
        try:
            return torch.cuda.get_device_properties(0).total_memory / (1024 ** 3)
        except Exception:
            return 0.0


def load_model() -> None:
    global _model, _processor, _device, _dtype, _quantized, _load_error
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
            import torch
            from transformers import AutoModelForCausalLM, AutoProcessor

            _device = _resolve_device(torch)
            _dtype = _resolve_dtype(torch, _device)
            load_kwargs: dict[str, Any] = {
                "trust_remote_code": True,
                "local_files_only": True,
                "low_cpu_mem_usage": True,
            }

            want_4bit = os.environ.get("SCIENCE_LOAD_IN_4BIT", "0").strip() in ("1", "true", "yes")
            if want_4bit and _device == "cuda":
                try:
                    from transformers import BitsAndBytesConfig

                    load_kwargs["quantization_config"] = BitsAndBytesConfig(
                        load_in_4bit=True,
                        bnb_4bit_compute_dtype=torch.bfloat16,
                        bnb_4bit_quant_type="nf4",
                        bnb_4bit_use_double_quant=True,
                    )
                    load_kwargs["device_map"] = {"": 0}
                    load_kwargs["torch_dtype"] = torch.bfloat16
                    _quantized = True
                except Exception as exc:  # bitsandbytes missing -> plain load
                    _load_error = f"4bit 量化不可用，改回普通加载：{exc}"
                    _quantized = False

            if not _quantized:
                load_kwargs["torch_dtype"] = _dtype

            _processor = AutoProcessor.from_pretrained(
                str(MODEL_DIR),
                trust_remote_code=True,
                local_files_only=True,
            )
            _model = AutoModelForCausalLM.from_pretrained(str(MODEL_DIR), **load_kwargs)
            if not _quantized:
                _model = _model.to(_device)
            _model.eval()
            _load_error = ""
        except Exception as exc:  # pragma: no cover - depends on local weights
            _load_error = f"科学模型加载失败：{exc}"
            _model = None
            _processor = None
            _quantized = False
            raise


def decode_image_data_url(value: str):
    """Turn an ``image_url`` value (data URL or raw base64) into a PIL image."""

    from PIL import Image

    match = _DATA_URL_RE.match(value or "")
    payload = match.group("data") if match else (value or "")
    try:
        raw = base64.b64decode(payload, validate=False)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("图片数据不是有效的 base64。") from exc
    try:
        return Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception as exc:
        raise ValueError("图片数据无法解析为图像。") from exc


def extract_messages(messages: list[dict[str, Any]] | None) -> tuple[str, list[str]]:
    """Split OpenAI-style messages into a text prompt and image data URLs."""

    texts: list[str] = []
    images: list[str] = []
    for message in messages or []:
        if not isinstance(message, dict):
            continue
        content = message.get("content")
        if isinstance(content, str):
            texts.append(content)
            continue
        for block in content or []:
            if not isinstance(block, dict):
                continue
            block_type = block.get("type")
            if block_type == "text":
                texts.append(str(block.get("text") or ""))
            elif block_type in ("image_url", "image"):
                image = block.get("image_url") or block.get("image") or {}
                url = image.get("url") if isinstance(image, dict) else image
                if url:
                    images.append(str(url))
    text = "\n".join(part for part in texts if part.strip()).strip()
    return text, images[:MAX_IMAGES]


def _materialize_image(image, directory: str, index: int) -> str:
    path = os.path.join(directory, f"image-{index}.png")
    image.save(path, "PNG")
    return path


def _run_processor(prompt: str, image_paths: list[str]) -> str:
    import torch

    content: list[dict[str, Any]] = [{"type": "image", "url": path} for path in image_paths]
    content.append({"type": "text", "text": prompt})
    messages = [{"role": "user", "content": content}]
    inputs = _processor.apply_chat_template(
        messages,
        add_generation_prompt=True,
        tokenize=True,
        return_dict=True,
        return_tensors="pt",
    )
    inputs = inputs.to(_device)
    for key, value in list(inputs.items()):
        if hasattr(value, "is_floating_point") and value.is_floating_point() and _dtype is not None:
            inputs[key] = value.to(_dtype)
    with torch.inference_mode():
        output = _model.generate(**inputs, max_new_tokens=MAX_NEW_TOKENS, do_sample=False)
    prompt_length = inputs["input_ids"].shape[-1]
    return _processor.decode(output[0][prompt_length:], skip_special_tokens=True).strip()


def _run_chat_fallback(prompt: str, image_paths: list[str]) -> str:
    """Fallback for InternVL-style checkpoints that expose ``model.chat``."""

    chat = getattr(_model, "chat", None)
    if not callable(chat):
        return ""
    import torch
    from PIL import Image

    tokenizer = _processor
    pixel_values = None
    if image_paths:
        loader = getattr(_model, "load_image", None)
        tensors = []
        for path in image_paths:
            tensor = loader(Image.open(path).convert("RGB"), max_num=12) if callable(loader) else None
            if tensor is None:
                return ""
            if tensor.dim() == 3:
                tensor = tensor.unsqueeze(0)
            tensors.append(tensor)
        pixel_values = torch.cat(tensors, dim=0).to(device=_device, dtype=_dtype)
    response = chat(tokenizer, pixel_values, prompt, {"max_new_tokens": MAX_NEW_TOKENS, "do_sample": False})
    if isinstance(response, tuple):
        return str(response[0]).strip()
    return str(response).strip()


def generate_text(prompt: str, image_urls: list[str] | None = None) -> str:
    load_model()
    image_urls = image_urls or []
    if _processor is not None and hasattr(_processor, "apply_chat_template"):
        directory = tempfile.mkdtemp(prefix="intern-science-")
        try:
            image_paths = [
                _materialize_image(decode_image_data_url(url), directory, index)
                for index, url in enumerate(image_urls)
            ]
            return _run_processor(prompt, image_paths)
        finally:
            shutil.rmtree(directory, ignore_errors=True)
    result = _run_chat_fallback(prompt, [])
    if result:
        return result
    raise RuntimeError("科学模型没有可用的推理入口，请检查 trust_remote_code 权重。")


@app.get("/v1/models")
def list_models() -> dict[str, Any]:
    return {
        "object": "list",
        "data": [{"id": MODEL_NAME, "object": "model", "created": int(time.time())}],
    }


@app.get("/health")
@app.get("/science/health")
def health() -> dict[str, Any]:
    missing = missing_files()
    info: dict[str, Any] = {
        "available": not missing,
        "ready": _model is not None,
        "model": MODEL_NAME,
        "device": _device,
        "dtype": str(_dtype).replace("torch.", "") if _dtype is not None else None,
        "quantized": _quantized,
        "missingFiles": missing,
        "error": _load_error,
    }
    if _device == "cuda":
        try:
            import torch

            info["vramFreeGb"] = round(_cuda_vram_gb(torch), 2)
        except Exception:
            pass
    return info


@app.post("/v1/chat/completions")
def chat_completions(request: ChatRequest) -> dict[str, Any]:
    prompt, image_urls = extract_messages(request.messages)
    if not prompt and not image_urls:
        raise HTTPException(status_code=400, detail="请求内容为空。")
    try:
        answer = generate_text(prompt, image_urls)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {
        "id": "chatcmpl-science",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": MODEL_NAME,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": answer},
                "finish_reason": "stop",
            }
        ],
    }
