"""Subprocess entry: download one HF repo, emitting progress as JSON lines.

Run as ``python -m crispin_tools.download_worker <repo_id>``. routers/downloads.py
spawns this and reads stdout for progress; it CANCELS by terminating the process
— the only reliable way to abort a Xet (hf_xet / Rust) download, which ignores
in-band tqdm cancellation (the Rust progress callback swallows the exception, so
a cancelled download would otherwise run to completion).
"""

from __future__ import annotations

import json
import sys
from typing import Any

from huggingface_hub import snapshot_download
from tqdm.auto import tqdm as base_tqdm

# Coalesce byte updates so a multi-GB download doesn't emit a line per chunk —
# the parent polls job.data only every 500ms, so finer granularity is wasted.
_EMIT_EVERY_BYTES = 4 * 1024 * 1024


def _emit(obj: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


class _ProgressTqdm(base_tqdm):
    """snapshot_download builds its aggregated byte bar (unit='B') from this
    class; we emit coalesced byte deltas. The file-count bar is ignored."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self._bytes_bar = kwargs.get("unit") == "B"
        self._pending = 0
        kwargs["disable"] = True  # no stderr bar — progress goes to stdout JSON
        super().__init__(*args, **kwargs)

    def update(self, n: float | None = 1) -> Any:
        if self._bytes_bar and n:
            self._pending += int(n)
            if self._pending >= _EMIT_EVERY_BYTES:
                _emit({"bytes": self._pending})
                self._pending = 0
        return super().update(n)

    def close(self) -> Any:
        if getattr(self, "_bytes_bar", False) and self._pending:
            _emit({"bytes": self._pending})  # flush the sub-threshold tail
            self._pending = 0
        return super().close()


def main() -> None:
    if len(sys.argv) != 2:
        _emit({"error": "usage: download_worker <repo_id>"})
        sys.exit(2)
    repo_id = sys.argv[1]
    try:
        path = snapshot_download(repo_id, tqdm_class=_ProgressTqdm)
    except Exception as exc:  # noqa: BLE001 — surfaced to the parent over stdout
        _emit({"error": str(exc)})
        sys.exit(1)
    _emit({"done": path})


if __name__ == "__main__":
    main()
