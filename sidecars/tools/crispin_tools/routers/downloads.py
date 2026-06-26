"""Model downloads and HF cache management.

Downloads run through the JobRegistry; Electron main polls GET /jobs/{id} and
reads job.data {repo_id, bytes_done, bytes_total} for byte-level progress.
All weights live in the shared HF cache (~/.cache/huggingface/hub).
"""

from __future__ import annotations

import json
import os
import queue
import signal
import subprocess
import sys
import threading
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from huggingface_hub import (
    CachedRepoInfo,
    CacheNotFound,
    HfApi,
    scan_cache_dir,
    try_to_load_from_cache,
)
from pydantic import BaseModel

from ..jobs import Job, registry

router = APIRouter(prefix="/models", tags=["models"])

# The download runs as a standalone subprocess (see _run_download). Resolve the
# worker's path here so it works regardless of the sidecar's cwd — the worker
# imports no crispin_tools modules, so it needs no package on sys.path.
_WORKER = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "download_worker.py")


class DownloadRequest(BaseModel):
    repo_id: str


def _human_gb(done: int, total: Optional[int]) -> str:
    gb = 1024**3
    if total:
        return f"{done / gb:.1f} / {total / gb:.1f} GB"
    return f"{done / gb:.1f} GB"


def _terminate(proc: subprocess.Popen) -> None:
    """SIGTERM the download process group, escalating to SIGKILL. start_new_session
    makes the child a group leader, so this reaps any helpers hf/xet spawn too."""
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        return
    try:
        proc.wait(timeout=10)
        return
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass


def _run_download(job: Job, repo_id: str) -> Optional[dict[str, Any]]:
    # Total size up-front from file metadata; None-safe (sizes can be missing).
    info = HfApi().model_info(repo_id, files_metadata=True)
    # _snapshot_complete needs the target revision to tell this download's
    # snapshot apart from previously completed ones.
    job.data["revision"] = info.sha
    siblings = [s for s in (info.siblings or []) if s.size is not None]
    total = sum(s.size for s in siblings) if siblings else None
    job.data["bytes_total"] = total
    if total is None:
        job.progress = -1.0  # indeterminate
    else:
        # Files completed on a previous attempt are short-circuited inside
        # hf_hub_download and never reach the progress bar — seed them here so
        # a resumed download doesn't sit below 100% while finishing.
        done = sum(
            s.size
            for s in siblings
            if isinstance(try_to_load_from_cache(repo_id, s.rfilename, revision=info.sha), str)
        )
        if done:
            job.data["bytes_done"] = done
            job.progress = min(done / total, 1.0)
            job.detail = _human_gb(done, total)

    # Run snapshot_download in a CHILD PROCESS, not this thread: the Xet
    # (hf_xet / Rust) downloader used for large repos ignores in-band tqdm
    # cancellation, so terminating the process is the only reliable abort.
    # Progress arrives as JSON lines on stdout; a reader thread feeds a queue so
    # the cancel check stays responsive even while a chunk is mid-flight.
    proc = subprocess.Popen(
        [sys.executable, _WORKER, repo_id],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        start_new_session=True,
    )
    lines: queue.Queue[Optional[str]] = queue.Queue()

    def _reader() -> None:
        try:
            assert proc.stdout is not None
            for line in proc.stdout:
                lines.put(line)
        finally:
            lines.put(None)  # EOF sentinel — the worker exited

    threading.Thread(target=_reader, name=f"dl-reader-{job.id[:8]}", daemon=True).start()

    result: Optional[dict[str, Any]] = None
    error: Optional[str] = None
    while True:
        if job.cancel_event.is_set():
            _terminate(proc)
            return None  # runner marks cancelled; partial files stay resumable
        try:
            line = lines.get(timeout=0.5)
        except queue.Empty:
            continue
        if line is None:
            break  # worker exited (EOF)
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        if "bytes" in msg:
            job.data["bytes_done"] += int(msg["bytes"])
            t = job.data["bytes_total"]
            job.progress = min(job.data["bytes_done"] / t, 1.0) if t else -1.0
            job.detail = _human_gb(job.data["bytes_done"], t)
        elif "done" in msg:
            result = {"path": msg["done"]}
        elif "error" in msg:
            error = msg["error"]

    proc.wait()
    if error is not None:
        raise RuntimeError(error)
    if result is None:
        # Worker exited without a terminal message (crash/kill) and we were not
        # cancelled — surface a failure rather than a phantom "done".
        raise RuntimeError(f"download worker exited unexpectedly (code {proc.returncode})")
    return result


@router.post("/download")
def start_download(body: DownloadRequest) -> dict[str, str]:
    job = registry.start(
        "model-download",
        lambda job: _run_download(job, body.repo_id),
        data={"repo_id": body.repo_id, "bytes_done": 0, "bytes_total": None},
    )
    return {"job_id": job.id}


def _snapshot_complete(repo: CachedRepoInfo) -> bool:
    """True when `repo` has at least one fully-downloaded snapshot.

    snapshot_download creates snapshots/<rev> up front and symlinks each file
    as it lands, so scan_cache_dir lists mid-download and interrupted repos
    with a partial size_on_disk — reporting those as installed would feed
    phantom models (with wrong memory estimates) to the UI and engine registry.
    """
    job = registry.find_running("model-download", repo_id=repo.repo_id)
    if job is not None:
        # Mid-download: only revisions other than the one being fetched can be
        # complete (a new-revision update of an installed model still counts).
        # Before model_info returns, the job has no target revision yet — we
        # cannot tell which revision is being fetched, so report incomplete
        # rather than blessing a possible resume-in-progress partial.
        target = job.data.get("revision")
        if target is None:
            return False
        return any(rev.commit_hash != target for rev in repo.revisions)
    # No live job: leftover *.incomplete temp blobs mean a download died
    # mid-file (process killed). A cancelled/failed download unlinks its temps
    # on the way out, so this is a heuristic, not a full validation.
    return not any((repo.repo_path / "blobs").glob("*.incomplete"))


def _snapshot_json(repo: CachedRepoInfo, filename: str) -> Optional[dict[str, Any]]:
    """Parsed json file from the newest snapshot, or None on any failure."""
    try:
        revision = max(repo.revisions, key=lambda rev: rev.last_modified or 0)
        parsed = json.loads((revision.snapshot_path / filename).read_text())
        return parsed if isinstance(parsed, dict) else None
    except Exception:
        return None


def _context_length(repo: CachedRepoInfo) -> Optional[int]:
    """max_position_embeddings from config.json, or None.

    Multimodal configs (gemma) nest it under text_config.
    """
    cfg = _snapshot_json(repo, "config.json")
    if cfg is None:
        return None
    return (cfg.get("text_config") or {}).get("max_position_embeddings") or cfg.get(
        "max_position_embeddings"
    )


def _sampling_defaults(repo: CachedRepoInfo) -> Optional[dict[str, Any]]:
    """The model's recommended sampling from generation_config.json, or None.

    Engines default to generic values (e.g. 0.7/0.9) instead of reading
    this file — main passes these per request so models run as their authors
    intended (gemma: temperature 1.0, top_k 64, top_p 0.95).
    """
    cfg = _snapshot_json(repo, "generation_config.json")
    if cfg is None:
        return None
    sampling = {key: cfg.get(key) for key in ("temperature", "top_p", "top_k")}
    return sampling if any(v is not None for v in sampling.values()) else None


@router.get("/local")
def local_models() -> dict[str, list[dict[str, Any]]]:
    try:
        cache = scan_cache_dir()
    except CacheNotFound:
        return {"models": []}
    models = [
        {
            "repo_id": repo.repo_id,
            "size_bytes": repo.size_on_disk,
            "last_modified_ms": int(repo.last_modified * 1000) if repo.last_modified else None,
            "context_length": _context_length(repo),
            "sampling": _sampling_defaults(repo),
        }
        for repo in cache.repos
        if repo.repo_type == "model" and _snapshot_complete(repo)
    ]
    models.sort(key=lambda m: m["repo_id"])
    return {"models": models}


@router.get("/search")
def search_models(q: str) -> dict[str, list[dict[str, Any]]]:
    # expand: the list endpoint omits lastModified unless asked explicitly.
    results = HfApi().list_models(
        filter="mlx",
        search=q,
        sort="downloads",
        limit=30,
        expand=["downloads", "likes", "lastModified"],
    )
    return {
        "results": [
            {
                "repo_id": m.id,
                "downloads": m.downloads or 0,
                "likes": m.likes or 0,
                "last_modified_ms": int(m.last_modified.timestamp() * 1000) if m.last_modified else None,
            }
            for m in results
        ]
    }


@router.delete("/{repo_id:path}")
def delete_model(repo_id: str) -> dict[str, bool]:
    # Deleting underneath an in-flight snapshot_download corrupts the cache
    # and crashes the worker — the partial repo is already visible to the UI.
    if registry.find_running("model-download", repo_id=repo_id) is not None:
        raise HTTPException(
            status_code=409, detail="a download for this model is in progress — cancel it first"
        )
    try:
        cache = scan_cache_dir()
    except CacheNotFound as exc:
        raise HTTPException(status_code=404, detail="no such model in cache") from exc
    repo = next(
        (r for r in cache.repos if r.repo_type == "model" and r.repo_id == repo_id), None
    )
    if repo is None:
        raise HTTPException(status_code=404, detail="no such model in cache")
    cache.delete_revisions(*(rev.commit_hash for rev in repo.revisions)).execute()
    return {"ok": True}
