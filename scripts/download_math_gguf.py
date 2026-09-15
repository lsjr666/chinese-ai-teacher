#!/usr/bin/env python
"""Download the Q4_K_M GGUF of Qwen2.5-Math-7B-Instruct.

Why: the math service currently loads the bfloat16 checkpoint with PyTorch on the
CPU, which needs ~15 GB of RAM and takes 320-828 seconds per question. The same
7B model quantised to Q4_K_M is 4.4 GB and runs through llama.cpp's SIMD kernels,
which is several times faster on the same CPU.

This reuses the resumable downloader written for the science model; it reads its
settings from environment variables, so we point those at the math repository
before importing it.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent

os.environ.setdefault("SCIENCE_MODEL_REPO", "lmstudio-community/Qwen2.5-Math-7B-Instruct-GGUF")
os.environ.setdefault("SCIENCE_MODEL_FILES", "Qwen2.5-Math-7B-Instruct-Q4_K_M.gguf")
os.environ.setdefault("SCIENCE_MODEL_DIR", str(ROOT / "models" / "Qwen2.5-Math-7B-Instruct-GGUF"))
os.environ.setdefault("SCIENCE_MODEL_FLATTEN", "1")
os.environ.setdefault("SCIENCE_DOWNLOAD_LOG", str(ROOT / ".cache" / "download-math-gguf.log"))
os.environ.setdefault("SCIENCE_DOWNLOAD_PROGRESS", str(ROOT / ".cache" / "download-math-progress.json"))
os.environ.setdefault("SCIENCE_DOWNLOAD_LOCK", str(ROOT / ".cache" / "download-math.lock"))

sys.path.insert(0, str(HERE))

import download_intern_mini as downloader  # noqa: E402  (env must be set first)

if __name__ == "__main__":
    sys.exit(downloader.main())
