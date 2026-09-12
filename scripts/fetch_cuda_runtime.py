#!/usr/bin/env python
"""Install the CUDA runtime DLLs that a CUDA-enabled llama.cpp build loads lazily.

A CUDA-enabled ``ggml-cuda.dll`` references ``cudart64_12.dll`` and
``cublas64_12.dll``, but neither ships with the prebuilt release, so llama.cpp
reports "Available devices: (none)" and falls back to the CPU. The libraries are
available (BSD/CUDA-EULA redistributable) inside the ``nvidia-*`` wheels on PyPI,
so this script downloads those wheels, pulls out the DLLs and drops them next to
``llama-server.exe``. Point it there with ``LLAMA_RUNTIME_DIR`` if the layout is
unusual.

Only Python's standard library is used, so it can be started unattended (for
example from a scheduled task) with any Python 3.8+.
"""

from __future__ import annotations

import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = Path(os.environ.get("LLAMA_RUNTIME_DIR", ROOT / "runtime"))
WHEELS = Path(os.environ.get("CUDA_WHEEL_DIR", ROOT / ".cache" / "cuda-wheels"))
LOG = Path(os.environ.get("CUDA_FETCH_LOG", ROOT / ".cache" / "cuda-runtime.log"))
# Mirror throughput for these multi-hundred-MB wheels differs by two orders of
# magnitude (measured: USTC 7.4 MB/s, Tencent 4.1, Tsinghua 3.8, aliyun 0.10), so
# the first reachable mirror in the list is used. Override with CUDA_INDEX_URLS.
DEFAULT_INDEXES = (
    "https://mirrors.ustc.edu.cn/pypi/simple/",
    "https://mirrors.cloud.tencent.com/pypi/simple/",
    "https://pypi.tuna.tsinghua.edu.cn/simple/",
    "https://mirrors.aliyun.com/pypi/simple/",
    "https://pypi.org/simple/",
)


def _indexes() -> list[str]:
    override = os.environ.get("CUDA_INDEX_URLS") or os.environ.get("CUDA_INDEX_URL")
    if override:
        return [item.strip().rstrip("/") + "/" for item in override.split(",") if item.strip()]
    return [item.rstrip("/") + "/" for item in DEFAULT_INDEXES]


INDEXES = _indexes()
PACKAGES = ["nvidia-cuda-runtime-cu12", "nvidia-cublas-cu12"]
# Every DLL llama.cpp may dlopen. Missing ones are skipped silently.
WANTED = ("cudart64_", "cublas64_", "cublaslt64_")
CHUNK = 1 << 20

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def log(message: str) -> None:
    line = "%s %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), message)
    print(line, flush=True)
    try:
        LOG.parent.mkdir(parents=True, exist_ok=True)
        with LOG.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    except OSError:
        pass


def open_url(url: str, headers: dict | None = None):
    request = urllib.request.Request(url, headers=headers or {"User-Agent": "ai-teacher/1.0"})
    return urllib.request.urlopen(request, timeout=60)


def pick_wheel_url(package: str, index: str) -> str:
    """Return the newest win_amd64 wheel for a package on one index."""

    base = index + package + "/"
    with open_url(base) as response:
        html = response.read().decode("utf-8", "replace")
    hrefs = re.findall(r'href="([^"]+\.whl(?:#[^"]*)?)"', html)
    if not hrefs:
        raise RuntimeError("no wheels listed for %s on %s" % (package, index))

    def version_key(href: str) -> tuple:
        name = href.rsplit("/", 1)[-1].split("#", 1)[0]
        parts = name.split("-")
        if len(parts) < 2:
            return (0,)
        return tuple(int(part) if part.isdigit() else 0 for part in parts[1].split("."))

    usable = [
        href for href in hrefs
        if "win_amd64" in href and Path(href.split("#", 1)[0]).name.startswith(package.replace("-", "_"))
    ]
    if not usable:
        raise RuntimeError("no win_amd64 wheel listed for %s on %s" % (package, index))
    newest = max(usable, key=version_key).split("#", 1)[0]
    return newest if newest.startswith("http") else urllib.parse.urljoin(base, newest)


def download(url: str, target: Path) -> Path:
    if target.exists() and target.stat().st_size > 0:
        log("[skip] %s already downloaded (%.1f MB)" % (target.name, target.stat().st_size / 1048576))
        return target
    part = target.with_suffix(target.suffix + ".part")
    attempt = 0
    while True:
        attempt += 1
        offset = part.stat().st_size if part.exists() else 0
        headers = {"User-Agent": "ai-teacher/1.0"}
        if offset:
            headers["Range"] = "bytes=%d-" % offset
        try:
            with open_url(url, headers) as response:
                if offset and response.status != 206:
                    part.unlink(missing_ok=True)
                    offset = 0
                written = offset
                last = time.time()
                with part.open("ab" if offset else "wb") as handle:
                    while True:
                        block = response.read(CHUNK)
                        if not block:
                            break
                        handle.write(block)
                        written += len(block)
                        if time.time() - last >= 20:
                            last = time.time()
                            log("[get] %s %.1f MB" % (target.name, written / 1048576))
            part.replace(target)
            log("[done] %s (%.1f MB)" % (target.name, target.stat().st_size / 1048576))
            return target
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            wait = min(30, 3 * attempt)
            log("[retry] %s attempt %d failed (%s); waiting %ds" % (target.name, attempt, exc, wait))
            if attempt >= 100:
                raise
            time.sleep(wait)


def extract(wheel: Path) -> list[str]:
    """Write the wanted DLLs into the runtime directory.

    Returns the DLLs that are present afterwards, so the caller can tell success
    from failure. An already-installed DLL is left alone: it is usually locked by
    a running llama-server, and overwriting it is neither possible nor needed.
    """

    copied = []
    with zipfile.ZipFile(wheel) as archive:
        for member in archive.namelist():
            name = Path(member).name.lower()
            if not name.endswith(".dll") or not name.startswith(WANTED):
                continue
            RUNTIME.mkdir(parents=True, exist_ok=True)
            destination = RUNTIME / Path(member).name
            if destination.exists() and destination.stat().st_size > 0:
                log("[skip] %s already present (%.1f MB)"
                    % (destination.name, destination.stat().st_size / 1048576))
                copied.append(destination.name)
                continue
            try:
                with archive.open(member) as source, destination.open("wb") as handle:
                    while True:
                        block = source.read(CHUNK)
                        if not block:
                            break
                        handle.write(block)
            except OSError as exc:
                log("[error] cannot write %s (%s); stop llama-server and re-run"
                    % (destination.name, exc))
                continue
            copied.append(destination.name)
            log("[extract] %s -> %s (%.1f MB)" % (member, destination, destination.stat().st_size / 1048576))
    return copied


def resolve_runtime() -> Path | None:
    """Find the directory that actually holds llama-server.exe.

    ``LLAMA_RUNTIME_DIR`` wins. Otherwise look next to this script, then in the
    current working directory, so the script also works when it is run straight
    from a skills directory with no project layout around it.
    """

    candidates = []
    override = os.environ.get("LLAMA_RUNTIME_DIR")
    if override:
        candidates.append(Path(override))
    candidates += [RUNTIME, Path.cwd() / "runtime", Path.cwd()]
    for candidate in candidates:
        if (candidate / "llama-server.exe").exists():
            return candidate
    return None


def main() -> int:
    global RUNTIME
    found = resolve_runtime()
    if found is None:
        log("[fatal] llama-server.exe not found; looked in %s and the current directory. "
            "Set LLAMA_RUNTIME_DIR to the folder holding llama-server.exe."
            % RUNTIME)
        return 1
    RUNTIME = found

    # Mirror hosts must bypass any system proxy: a stale proxy setting is a common
    # reason these downloads hang.
    hosts = [urllib.parse.urlparse(index).hostname for index in INDEXES]
    hosts = [host for host in hosts if host]
    existing = [item for item in os.environ.get("NO_PROXY", "").split(",") if item.strip()]
    merged = existing + [host for host in hosts if host not in existing] + ["127.0.0.1", "localhost"]
    os.environ["NO_PROXY"] = ",".join(dict.fromkeys(merged))
    os.environ["no_proxy"] = os.environ["NO_PROXY"]

    WHEELS.mkdir(parents=True, exist_ok=True)
    copied: list[str] = []
    for package in PACKAGES:
        for index in INDEXES:
            try:
                url = pick_wheel_url(package, index)
            except Exception as exc:
                log("[mirror] %s not usable for %s (%s)" % (index, package, exc))
                continue
            try:
                log("[resolve] %s -> %s (%s)" % (package, url.rsplit("/", 1)[-1], index))
                wheel = download(url, WHEELS / url.rsplit("/", 1)[-1])
                copied.extend(extract(wheel))
                break
            except Exception as exc:
                log("[error] %s from %s: %s" % (package, index, exc))
        else:
            log("[error] every mirror failed for %s" % package)

    if not copied:
        log("[fatal] no CUDA DLLs were extracted")
        return 1
    log("[complete] CUDA runtime ready in %s: %s" % (RUNTIME, ", ".join(sorted(set(copied)))))
    log("Restart the science service; llama-server --list-devices should now show the GPU.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
