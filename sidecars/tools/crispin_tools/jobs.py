"""In-process background job registry.

Long-running work (model downloads, RAG ingest) runs in a thread and reports
progress here; Electron main polls GET /jobs/{id} and re-broadcasts to the UI.
"""

from __future__ import annotations

import threading
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Optional


@dataclass
class Job:
    id: str
    kind: str
    status: str = "running"  # running|done|failed|cancelled
    progress: float = 0.0  # 0..1, or -1 when indeterminate
    detail: str = ""
    error: Optional[str] = None
    result: Optional[Any] = None
    data: dict[str, Any] = field(default_factory=dict)  # kind-specific live payload (e.g. byte counters)
    cancel_event: threading.Event = field(default_factory=threading.Event)

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "kind": self.kind,
            "status": self.status,
            "progress": self.progress,
            "detail": self.detail,
            "error": self.error,
            "result": self.result,
            "data": self.data,
        }


class JobRegistry:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()

    def get(self, job_id: str) -> Optional[Job]:
        with self._lock:
            return self._jobs.get(job_id)

    def find_running(self, kind: str, **data_match: Any) -> Optional[Job]:
        """First running job of `kind` whose job.data matches all given keys."""
        with self._lock:
            for job in self._jobs.values():
                if (
                    job.kind == kind
                    and job.status == "running"
                    and all(job.data.get(k) == v for k, v in data_match.items())
                ):
                    return job
        return None

    def cancel(self, job_id: str) -> bool:
        job = self.get(job_id)
        if job is None or job.status != "running":
            return False
        job.cancel_event.set()
        return True

    def start(self, kind: str, fn: Callable[[Job], Any], data: Optional[dict[str, Any]] = None) -> Job:
        """Run fn(job) in a daemon thread; fn sets progress/detail/data as it goes."""
        job = Job(id=uuid.uuid4().hex, kind=kind, data=data or {})
        with self._lock:
            self._jobs[job.id] = job

        def runner() -> None:
            try:
                result = fn(job)
                if job.cancel_event.is_set():
                    job.status = "cancelled"
                else:
                    job.result = result
                    job.progress = 1.0
                    job.status = "done"
            except Exception as exc:  # noqa: BLE001 — surfaced to the UI
                job.error = str(exc)
                job.status = "failed"

        threading.Thread(target=runner, name=f"job-{kind}-{job.id[:8]}", daemon=True).start()
        return job


registry = JobRegistry()
