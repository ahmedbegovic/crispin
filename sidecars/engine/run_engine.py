"""Launcher for the vllm-mlx engine sidecar — the only file that knows engine CLI flags.

Electron main rewrites <dataDir>/engine/engine-config.json before every spawn
(model registry, port, memory budget); this script renders the vllm-mlx
models-config YAML next to it and runs vllm_mlx.cli in-process so the
supervisor's process-group signals land on a single PID.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, NoReturn


def fail(message: str) -> NoReturn:
    """Config errors are loud and fast: Electron main should never cause them."""
    print(f"run_engine: {message}", file=sys.stderr)
    sys.exit(2)


def build_argv(config_path: Path) -> list[str]:
    """Read engine-config.json, write models-config.yaml beside it, return serve argv."""
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
        contention = config.get("contention") or {}
        registry = {
            "manager": {
                "memory_budget_gb": budget_gb,
                "contention_policy": {
                    "strategy": contention.get("strategy", "wait_then_fail"),
                    "wait_timeout_s": float(contention.get("wait_timeout_s", 180)),
                },
            },
            "models": [
                {
                    "name": m["name"],
                    "source": m["source"],
                    "preload": False,  # lazy loading is the point: load on first request
                    "estimated_memory_gb": float(m["estimated_memory_gb"]),
                }
                for m in models
            ],
        }
    except (KeyError, TypeError, ValueError) as exc:
        fail(f"config field missing or invalid: {exc!r}")

    import yaml  # vllm-mlx dependency; always present in the engine venv

    yaml_path = config_path.parent / "models-config.yaml"
    yaml_path.write_text(yaml.safe_dump(registry, sort_keys=False))

    argv = [
        "vllm-mlx",
        "serve",
        "--models-config",
        str(yaml_path),
        "--host",
        "127.0.0.1",
        "--port",
        str(port),
        "--enable-auto-tool-choice",
        "--tool-call-parser",
        "auto",
        # Small models get ctx-bounded generation (uncapped reasoning); the
        # per-request cap for the ultra tier comes from the orchestrator.
        "--max-tokens",
        "131072",
        "--max-request-tokens",
        "131072",
        # Weights come from the shared HF cache; downloads are the tools sidecar's job.
        "--offline",
    ]
    # Deliberately simple mode, no KV-cache quantization: the KV-quant flags
    # only take effect under --continuous-batching, and vllm-mlx 0.3.0's
    # batched path cannot generate with gemma-4 models at all
    # (patch_gemma4_attention_for_batching rejects the shared_kv kwarg).
    # Revisit both together when upstream fixes batched gemma-4.
    # No --auto-unload-idle-seconds either: it is inert in registry mode (only
    # wired up for single-model serve). Electron main owns the idle-unload timer.
    return argv


def main() -> None:
    parser = argparse.ArgumentParser(prog="run_engine")
    parser.add_argument("--config", required=True, help="path to engine-config.json")
    parser.add_argument(
        "--print-args",
        action="store_true",
        help="print the final vllm-mlx argv as JSON and exit (dry run)",
    )
    args = parser.parse_args()

    argv = build_argv(Path(args.config))
    if args.print_args:
        print(json.dumps(argv))
        return

    # Run the CLI in-process: one PID, so SIGTERM/SIGKILL from the supervisor
    # hit the actual server. Imported late so config errors stay fast.
    sys.argv = argv
    _patch_registry_model_name()
    from vllm_mlx.cli import main as cli_main

    cli_main()


def _patch_registry_model_name() -> None:
    """Work around a vllm-mlx 0.3.0 bug: registry mode leaves the module-global
    `_model_name` as None, and every ChatCompletionResponse/Chunk is built with
    `model=_model_name` — so ALL chat completions 500 on pydantic validation.
    Give the global a constant placeholder after the registry loads; clients
    ignore the echoed model name.
    """
    import vllm_mlx.server as server

    original = server.load_model_registry

    def patched(config_path, *, defaults):  # noqa: ANN001 — mirrors upstream
        original(config_path, defaults=defaults)
        server._model_name = "vllm-mlx"

    server.load_model_registry = patched


if __name__ == "__main__":
    main()
