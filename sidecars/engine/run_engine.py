"""Launcher for the oMLX engine sidecar — the only file that knows engine CLI flags.

Electron main rewrites <dataDir>/engine/engine-config.json before every spawn
(port, memory budget, per-model settings); this script merges the per-model
settings into oMLX's ~/.omlx/model_settings.json and runs omlx.cli in-process
so the supervisor's process-group signals land on a single PID.

oMLX discovers models from the shared HF cache by itself (--hf-cache default),
serves them lazily with LRU eviction under --memory-guard-gb, and exposes real
per-model load/unload endpoints — no registry YAML, no monkeypatches. Engine
model ids are the HF repo id with '/' replaced by '--'; main maps both ways.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, NoReturn

SETTINGS_VERSION = 1


def fail(message: str) -> NoReturn:
    """Config errors are loud and fast: Electron main should never cause them."""
    print(f"run_engine: {message}", file=sys.stderr)
    sys.exit(2)


def engine_model_id(repo_id: str) -> str:
    """oMLX flattens HF repo ids into directory-safe ids."""
    return repo_id.replace("/", "--")


def write_model_settings(models: list[dict[str, Any]]) -> None:
    """Merge Orion's per-model settings into oMLX's model_settings.json.

    Only the keys Orion manages are overwritten; settings the user tuned in
    oMLX's own admin UI (and entries for models Orion doesn't know) survive.
    """
    path = Path.home() / ".omlx" / "model_settings.json"
    try:
        data = json.loads(path.read_text())
        if not isinstance(data, dict) or not isinstance(data.get("models"), dict):
            raise ValueError
    except Exception:
        data = {"version": SETTINGS_VERSION, "models": {}}

    for m in models:
        model_id = engine_model_id(m["name"])
        entry = data["models"].get(model_id)
        # A hand-edited non-dict entry is corruption like any other: reset it
        # rather than crash blaming engine-config.json for the wrong file.
        if not isinstance(entry, dict):
            entry = data["models"][model_id] = {}
        # Per-model output budget: ctx-bounded for small tiers, capped for ultra.
        entry["max_tokens"] = int(m["max_tokens"])
        # Thinking is parsed into reasoning_content server-side, so it is safe
        # for OpenAI clients (opencode) and wanted by the Chat tab.
        entry["enable_thinking"] = bool(m["enable_thinking"])
        # Idle auto-unload is the engine's job now (was a main-side timer).
        entry["ttl_seconds"] = m["ttl_seconds"]

    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2) + "\n")
        tmp.replace(path)
    except OSError as exc:
        fail(f"cannot write {path}: {exc}")


def build_argv(config_path: Path) -> tuple[list[str], list[dict[str, Any]]]:
    """Read engine-config.json, return (serve argv, per-model settings)."""
    try:
        config: dict[str, Any] = json.loads(config_path.read_text())
    except FileNotFoundError:
        fail(f"config not found: {config_path}")
    except json.JSONDecodeError as exc:
        fail(f"config is not valid JSON: {exc}")

    models = config.get("models") or []
    if not models:
        fail("config has an empty models list — nothing to serve")

    try:
        port = int(config["port"])
        budget_gb = float(config["memory_budget_gb"])
    except (KeyError, TypeError, ValueError) as exc:
        fail(f"config field missing or invalid: {exc!r}")

    return [
        "omlx",
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        str(port),
        "--memory-guard-gb",
        str(budget_gb),
        "--log-level",
        "info",
    ], models


def main() -> None:
    parser = argparse.ArgumentParser(prog="run_engine")
    parser.add_argument("--config", required=True, help="path to engine-config.json")
    parser.add_argument(
        "--print-args",
        action="store_true",
        help="print the final omlx argv as JSON and exit (dry run)",
    )
    args = parser.parse_args()

    argv, models = build_argv(Path(args.config))
    if args.print_args:
        print(json.dumps(argv))
        return

    # After the dry-run exit: ~/.omlx/model_settings.json is shared with the
    # standalone oMLX app, and a debugging --print-args must not rewrite it.
    try:
        write_model_settings(models)
    except (KeyError, TypeError, ValueError) as exc:
        fail(f"config field missing or invalid: {exc!r}")

    # Weights come from the shared HF cache; downloads are the tools sidecar's
    # job — never let the engine reach for the network.
    os.environ.setdefault("HF_HUB_OFFLINE", "1")

    # Run the CLI in-process: one PID, so SIGTERM/SIGKILL from the supervisor
    # hit the actual server. Imported late so config errors stay fast.
    sys.argv = argv
    from omlx.cli import main as cli_main

    cli_main()


if __name__ == "__main__":
    main()
