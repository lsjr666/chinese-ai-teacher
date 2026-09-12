#!/usr/bin/env python
"""Download just the two GGUF files needed to serve Intern-S1-mini.

The full ``Intern-S1-mini`` checkpoint is bfloat16 and needs ~16 GB of RAM while
``Intern-S1-mini-GGUF`` ships several quantisations (f16 alone is 15.6 GB). This
launcher pins the download to the Q8_0 weights plus their vision projector, which
is what the CPU/llama.cpp serving path uses, and writes them flat into
``models/Intern-S1-mini-GGUF``.

Every setting can still be overridden from the environment; the values here are
only defaults.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent

os.environ.setdefault("SCIENCE_MODEL_REPO", "Shanghai_AI_Laboratory/Intern-S1-mini-GGUF")
os.environ.setdefault(
    "SCIENCE_MODEL_FILES",
    "Q8_0/Intern-S1-mini-Q8_0.gguf,Q8_0/mmproj-Intern-S1-mini-Q8_0.gguf",
)
os.environ.setdefault("SCIENCE_MODEL_DIR", str(ROOT / "models" / "Intern-S1-mini-GGUF"))
os.environ.setdefault("SCIENCE_MODEL_FLATTEN", "1")
os.environ.setdefault("SCIENCE_DOWNLOAD_LOG", str(ROOT / ".cache" / "download-science-gguf.log"))
os.environ.setdefault("SCIENCE_DOWNLOAD_PROGRESS", str(ROOT / ".cache" / "download-gguf-progress.json"))
os.environ.setdefault("SCIENCE_DOWNLOAD_LOCK", str(ROOT / ".cache" / "download-gguf.lock"))

sys.path.insert(0, str(HERE))

import download_intern_mini as downloader  # noqa: E402  (env must be set first)

if __name__ == "__main__":
    sys.exit(downloader.main())
