#!/usr/bin/env python
"""Resumable, self-contained downloader for the Intern-S1-mini weights.

Why not just use ``modelscope.snapshot_download``? It works interactively, but we
need a download that can be (re)started unattended for hours - for example from a
Windows scheduled task, or after a network drop. This script:

* fetches the file list straight from the ModelScope HTTP API (no SDK needed);
* writes every file to ``<name>.part`` and renames it only when the byte count
  matches, so a half-written file can never be mistaken for a good one;
* resumes from the current ``.part`` size with an HTTP Range request, and falls
  back to a clean restart when the server ignores the range (HTTP 200);
* keeps a machine-readable progress file for status checks;
* refuses to run twice at once (a repeating scheduled task stays safe).

Exit codes: 0 = all files complete, 3 = still incomplete (safe to run again),
1 = fatal error.
"""

from __future__ import annotations

import fnmatch
import json
import os
import shutil
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REPO = os.environ.get("SCIENCE_MODEL_REPO", "Shanghai_AI_Laboratory/Intern-S1-mini")
REVISION = os.environ.get("SCIENCE_MODEL_REVISION", "master")
API_FILES = (
    "https://www.modelscope.cn/api/v1/models/{repo}/repo/files"
    "?Revision={rev}&Recursive=true"
)
API_FILE = (
    "https://www.modelscope.cn/api/v1/models/{repo}/repo"
    "?Revision={rev}&FilePath={path}"
)

ROOT = Path(__file__).resolve().parents[1]
DEST = Path(os.environ.get("SCIENCE_MODEL_DIR", ROOT / "models" / "Intern-S1-mini"))
LOG = Path(os.environ.get("SCIENCE_DOWNLOAD_LOG", ROOT / ".cache" / "download-science.log"))
PROGRESS = Path(os.environ.get("SCIENCE_DOWNLOAD_PROGRESS", ROOT / ".cache" / "download-progress.json"))
LOCK = Path(os.environ.get("SCIENCE_DOWNLOAD_LOCK", ROOT / ".cache" / "download.lock"))
WORKERS = int(os.environ.get("SCIENCE_DOWNLOAD_WORKERS", "4"))
TIMEOUT = int(os.environ.get("SCIENCE_DOWNLOAD_TIMEOUT", "60"))
CHUNK = 256 * 1024

# Optional allow-list. A GGUF repository can be 25 GB of alternative quantisations
# while we only want two of them, so SCIENCE_MODEL_FILES takes comma/semicolon
# separated globs matched against the repository path.
FILTERS = [
    item.strip()
    for item in os.environ.get("SCIENCE_MODEL_FILES", "").replace(";", ",").split(",")
    if item.strip()
]
# GGUF repositories nest the weights under a quantisation folder; flatten them so
# the launcher can address a single predictable path.
FLATTEN = os.environ.get("SCIENCE_MODEL_FLATTEN", "0").strip().lower() in ("1", "true", "yes")

# Keeps the Chinese text readable no matter which console hosts the process.
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

_log_lock = threading.Lock()
_state_lock = threading.Lock()
_progress = {"startedAt": time.time(), "files": {}, "totalBytes": 0}


def log(message: str) -> None:
    line = "%s %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), message)
    with _log_lock:
        print(line, flush=True)
        try:
            LOG.parent.mkdir(parents=True, exist_ok=True)
            with LOG.open("a", encoding="utf-8") as handle:
                handle.write(line + "\n")
        except OSError:
            pass


def write_progress() -> None:
    with _state_lock:
        # Every entry holds an absolute byte count, so the sum is the real
        # progress even while large shards are still in flight.
        done = sum(int(entry.get("bytes") or 0) for entry in _progress["files"].values())
        snapshot = {
            "startedAt": _progress["startedAt"],
            "totalBytes": _progress["totalBytes"],
            "doneBytes": done,
            "percent": round(done / _progress["totalBytes"] * 100, 2)
            if _progress["totalBytes"]
            else 0.0,
            "updatedAt": time.time(),
            "files": dict(_progress["files"]),
        }
    try:
        PROGRESS.parent.mkdir(parents=True, exist_ok=True)
        tmp = PROGRESS.with_suffix(".tmp")
        tmp.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(PROGRESS)
    except OSError:
        pass


def acquire_lock() -> bool:
    """Return False when another live downloader already owns the lock."""

    try:
        if LOCK.exists():
            try:
                old = int(LOCK.read_text(encoding="utf-8").strip() or "0")
            except (ValueError, OSError):
                old = 0
            alive = False
            if old:
                try:
                    os.kill(old, 0)
                    alive = True
                except OSError:
                    alive = False
            if alive and old != os.getpid():
                return False
        LOCK.parent.mkdir(parents=True, exist_ok=True)
        LOCK.write_text(str(os.getpid()), encoding="utf-8")
        return True
    except OSError:
        return True


def release_lock() -> None:
    try:
        if LOCK.exists() and LOCK.read_text(encoding="utf-8").strip() == str(os.getpid()):
            LOCK.unlink()
    except OSError:
        pass


def open_url(url: str, headers: dict | None = None, timeout: int = TIMEOUT):
    request = urllib.request.Request(url, headers=headers or {})
    return urllib.request.urlopen(request, timeout=timeout)


def list_files() -> list[dict]:
    url = API_FILES.format(repo=REPO, rev=REVISION)
    with open_url(url, headers={"User-Agent": "ai-teacher/1.0"}) as response:
        payload = json.loads(response.read().decode("utf-8"))
    files = payload.get("Data", {}).get("Files", [])
    files = [item for item in files if item.get("Type", "blob") != "tree"]
    if FILTERS:
        files = [
            item for item in files
            if any(fnmatch.fnmatch(item.get("Path", ""), pattern) for pattern in FILTERS)
        ]
    return files


def target_name(name: str) -> str:
    return Path(name).name if FLATTEN else name


def part_path(name: str) -> Path:
    return DEST / (target_name(name) + ".part")


def final_path(name: str) -> Path:
    return DEST / target_name(name)


def verify_prefix(part: Path, name: str) -> bool:
    """Sanity-check that an existing .part is a contiguous prefix.

    ModelScope's own downloader leaves ``.incomplete`` files behind; we reuse them
    as ``.part``. Before trusting one we compare the first and last megabyte
    against the server, which catches truncated-then-padded or interleaved files.
    """

    size = part.stat().st_size
    if size == 0:
        return True
    url = API_FILE.format(repo=REPO, rev=REVISION, path=urllib.parse.quote(name))
    probes = [(0, min(1024 * 1024, size))]
    if size > 2 * 1024 * 1024:
        probes.append((size - 1024 * 1024, 1024 * 1024))
    try:
        with part.open("rb") as handle:
            for offset, length in probes:
                handle.seek(offset)
                local = handle.read(length)
                with open_url(url, headers={
                    "Range": "bytes=%d-%d" % (offset, offset + length - 1),
                    "User-Agent": "ai-teacher/1.0",
                }) as response:
                    if response.status != 206:
                        return False
                    remote = response.read(length)
                if local != remote:
                    return False
    except (urllib.error.URLError, OSError):
        return False
    return True


def download_one(item: dict) -> None:
    name = item["Path"]
    expected = int(item.get("Size") or 0)
    target = final_path(name)

    if target.exists() and (expected == 0 or target.stat().st_size == expected):
        with _state_lock:
            _progress["files"][name] = {"state": "done", "bytes": target.stat().st_size}
        log("[skip] %s (complete)" % name)
        return

    if target.exists():
        log("[redo] %s size mismatch, restarting" % name)
        target.unlink()

    part = part_path(name)
    part.parent.mkdir(parents=True, exist_ok=True)
    legacy = DEST / (target_name(name) + ".incomplete")
    if legacy.exists() and not part.exists():
        try:
            shutil.move(str(legacy), str(part))
            log("[resume] adopted ModelScope partial %s (%.1f MB)"
                % (name, part.stat().st_size / 1048576))
        except OSError:
            pass

    if part.exists() and part.stat().st_size > 0 and not verify_prefix(part, name):
        log("[redo] %s partial failed verification, restarting" % name)
        part.unlink()

    url = API_FILE.format(repo=REPO, rev=REVISION, path=urllib.parse.quote(name))
    attempt = 0
    while True:
        attempt += 1
        offset = part.stat().st_size if part.exists() else 0
        if expected and offset >= expected:
            part.replace(target)
            with _state_lock:
                _progress["files"][name] = {"state": "done", "bytes": expected}
            log("[done] %s (%.1f MB)" % (name, expected / 1048576))
            return
        headers = {"User-Agent": "ai-teacher/1.0"}
        if offset:
            headers["Range"] = "bytes=%d-" % offset
        try:
            with open_url(url, headers=headers) as response:
                # Server ignored our range -> the local bytes cannot be trusted.
                if offset and response.status != 206:
                    log("[warn] %s server ignored Range, restarting from 0" % name)
                    part.unlink(missing_ok=True)
                    offset = 0
                mode = "ab" if offset else "wb"
                written = offset
                last_report = time.time()
                with part.open(mode) as handle:
                    while True:
                        block = response.read(CHUNK)
                        if not block:
                            break
                        handle.write(block)
                        written += len(block)
                        with _state_lock:
                            _progress["files"][name] = {"state": "downloading", "bytes": written}
                        if time.time() - last_report >= 15:
                            last_report = time.time()
                            log("[get] %s %.1f/%.1f MB" % (
                                name, written / 1048576,
                                (expected or written) / 1048576,
                            ))
                            write_progress()
            size = part.stat().st_size
            if expected and size != expected:
                log("[warn] %s incomplete %d/%d bytes, resuming" % (name, size, expected))
                continue
            part.replace(target)
            with _state_lock:
                _progress["files"][name] = {"state": "done", "bytes": size}
            log("[done] %s (%.1f MB)" % (name, size / 1048576))
            write_progress()
            return
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            wait = min(30, 2 * attempt)
            log("[retry] %s attempt %d failed (%s); waiting %ds" % (name, attempt, exc, wait))
            write_progress()
            if attempt >= 200:
                raise
            time.sleep(wait)


def worker(queue: list[dict], lock: threading.Lock) -> None:
    while True:
        with lock:
            if not queue:
                return
            item = queue.pop(0)
        try:
            download_one(item)
        except Exception as exc:  # keep other shards moving
            log("[error] %s: %s" % (item.get("Path"), exc))


def main() -> int:
    DEST.mkdir(parents=True, exist_ok=True)

    if not acquire_lock():
        log("[skip] another downloader is already running")
        return 0

    try:
        files = list_files()
        if not files:
            log("[fatal] ModelScope returned an empty file list")
            return 1
        total = sum(int(item.get("Size") or 0) for item in files)
        # Files already complete on disk move doneBytes forward below.
        already = 0
        for item in files:
            name = item["Path"]
            target = final_path(name)
            expected = int(item.get("Size") or 0)
            if target.exists() and (expected == 0 or target.stat().st_size == expected):
                already += target.stat().st_size
                with _state_lock:
                    _progress["files"][name] = {"state": "done", "bytes": target.stat().st_size}
                continue
            # Bytes carried over from an interrupted run still count as progress.
            for candidate in (part_path(name), DEST / (target_name(name) + ".incomplete")):
                if candidate.exists():
                    carried = candidate.stat().st_size
                    already += carried
                    with _state_lock:
                        _progress["files"][name] = {"state": "pending", "bytes": carried}
                    break
        with _state_lock:
            _progress["totalBytes"] = total
        log("[start] %d files, %.2f GB total, %.2f GB already present, %d workers"
            % (len(files), total / 1073741824, already / 1073741824, WORKERS))
        write_progress()

        queue = [item for item in files if not (
            final_path(item["Path"]).exists()
            and (int(item.get("Size") or 0) == 0
                 or final_path(item["Path"]).stat().st_size == int(item.get("Size") or 0))
        )]
        # Small files first so tokenizer/config land early.
        queue.sort(key=lambda item: int(item.get("Size") or 0))

        guard = threading.Lock()
        threads = [threading.Thread(target=worker, args=(queue, guard), daemon=True)
                   for _ in range(max(1, min(WORKERS, len(queue) or 1)))]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        write_progress()
        missing = []
        for item in files:
            target = final_path(item["Path"])
            expected = int(item.get("Size") or 0)
            if not target.exists() or (expected and target.stat().st_size != expected):
                missing.append(item["Path"])
        if missing:
            log("[incomplete] %d file(s) still missing: %s" % (len(missing), ", ".join(missing)))
            return 3
        log("[complete] all %d files verified in %s" % (len(files), DEST))
        write_progress()
        return 0
    finally:
        release_lock()


if __name__ == "__main__":
    sys.exit(main())
