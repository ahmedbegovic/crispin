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
import fcntl
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
    """Merge Crispin's per-model settings into oMLX's model_settings.json.

    Only the keys Crispin manages are overwritten; settings the user tuned in
    oMLX's own admin UI (and entries for models Crispin doesn't know) survive.
    """
    path = Path.home() / ".omlx" / "model_settings.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    # Best-effort exclusive lock around the read-modify-write so two Crispin
    # engine starts can't clobber each other's merge. NOTE: it cannot coordinate
    # with the standalone oMLX app (a separate process that doesn't take this
    # lock) — that cross-app race is last-writer-wins on a shared file we don't
    # own. The window is a single startup-time write, so the residual risk is
    # accepted rather than papered over.
    with open(path.with_suffix(".lock"), "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX)
        except OSError:
            pass  # locking unsupported — proceed unlocked rather than fail startup

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
            # TurboQuant KV-cache quant. Defensive .get defaults keep an older
            # engine-config.json (written before this app upgrade, before the
            # first rewrite) safe — absent keys mean full-precision KV. The keys
            # are always written when disabled too (enabled=False), so flipping
            # the policy off clears a model's prior `true` rather than stranding it.
            entry["turboquant_kv_enabled"] = bool(m.get("turboquant_kv_enabled", False))
            entry["turboquant_kv_bits"] = float(m.get("turboquant_kv_bits", 4))
            entry["turboquant_skip_last"] = bool(m.get("turboquant_skip_last", True))
            # oMLX's ModelSettings rejects turboquant_kv together with MTP/VLM-MTP
            # and then SKIPS the whole entry — the model would load with DEFAULTS
            # (no KV quant, no max_tokens cap, no ttl), silently. The standalone
            # oMLX app can set those flags in this shared file, so clear the
            # mutually-exclusive pair whenever we enable turboquant. (dflash /
            # specprefill are NOT exclusive with turboquant — leave them alone.)
            if entry["turboquant_kv_enabled"]:
                entry.pop("mtp_enabled", None)
                entry.pop("vlm_mtp_enabled", None)

        try:
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(data, indent=2) + "\n")
            tmp.replace(path)
        except OSError as exc:
            fail(f"cannot write {path}: {exc}")


def build_argv(config_path: Path) -> tuple[list[str], list[dict[str, Any]], float]:
    """Read engine-config.json, return (serve argv, per-model settings, moe_offload_gb)."""
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

    argv = [
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
    ]

    # Crispin owns the paged SSD KV-cache: a fixed dir under the app's data
    # directory and a hard size cap, instead of oMLX's default "auto" (≈10% of
    # free disk) that silently grows ~/.omlx/cache. Keeps the prefix-cache speedup.
    cache = config.get("cache")
    if isinstance(cache, dict) and cache.get("dir"):
        argv += ["--paged-ssd-cache-dir", str(cache["dir"])]
        max_gb = cache.get("max_size_gb")
        if max_gb:
            argv += ["--paged-ssd-cache-max-size", f"{int(float(max_gb))}GB"]

    try:
        moe_offload_gb = float(config.get("moe_offload_gb", 0) or 0)
    except (TypeError, ValueError):
        moe_offload_gb = 0.0

    return argv, models, moe_offload_gb


def main() -> None:
    parser = argparse.ArgumentParser(prog="run_engine")
    parser.add_argument("--config", required=True, help="path to engine-config.json")
    parser.add_argument(
        "--print-args",
        action="store_true",
        help="print the final omlx argv as JSON and exit (dry run)",
    )
    args = parser.parse_args()

    argv, models, moe_offload_gb = build_argv(Path(args.config))
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

    # MoE expert offload (Crispin fork): when enabled, the engine streams cold experts
    # from disk for large MoE models, freeing their resident weight RAM (trades speed
    # for memory). Set UNCONDITIONALLY from the config (not setdefault) so the config is
    # authoritative — a stale inherited OMLX_MOE_OFFLOAD_GB must not shadow it, and
    # toggling the setting OFF must actually clear it.
    if moe_offload_gb > 0:
        os.environ["OMLX_MOE_OFFLOAD_GB"] = str(moe_offload_gb)
    else:
        os.environ.pop("OMLX_MOE_OFFLOAD_GB", None)

    # Run the CLI in-process: one PID, so SIGTERM/SIGKILL from the supervisor
    # hit the actual server. Imported late so config errors stay fast.
    sys.argv = argv
    from omlx.cli import main as cli_main

    cli_main()


if __name__ == "__main__":
    main()
