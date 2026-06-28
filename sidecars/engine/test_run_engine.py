"""Plain-assert tests for run_engine's MoE-offload config->env translation.

Run with the engine venv python (no pytest needed, stdlib only):

    sidecars/engine/.venv/bin/python sidecars/engine/test_run_engine.py

run_engine.py's omlx import is lazy (inside main(), under the __main__ guard), so
importing the module here is side-effect-free. The TS side (engine-config.test.ts)
covers writing these fields into engine-config.json; this covers reading them back out
into the OMLX_MOE_* env vars the engine actually consumes — the seam that previously
crashed on `float("auto")`.
"""

import run_engine as r


def check(name: str, cond: bool) -> None:
    assert cond, name
    print("ok:", name)


def main() -> None:
    # read_offload_config — off / fixed / auto / junk, plus the two flags.
    check("off when absent", r.read_offload_config({})["gb"] == 0.0)
    check("fixed numeric", r.read_offload_config({"moe_offload_gb": 6})["gb"] == 6.0)
    check("auto string", r.read_offload_config({"moe_offload_gb": "auto"})["gb"] == "auto")
    check("AUTO case-insensitive", r.read_offload_config({"moe_offload_gb": "AUTO"})["gb"] == "auto")
    check("junk -> 0 (never crashes)", r.read_offload_config({"moe_offload_gb": "xyz"})["gb"] == 0.0)
    check("dynamic flag parsed", r.read_offload_config({"moe_offload_dynamic": True})["dynamic"] is True)
    check("optimistic flag parsed", r.read_offload_config({"moe_offload_optimistic": True})["optimistic"] is True)

    # offload_env — off clears everything.
    check("off -> no env", r.offload_env({"gb": 0.0, "dynamic": False, "optimistic": False}) == {})

    # Fixed cache: numeric GB, no dynamic.
    check(
        "fixed sets GB only",
        r.offload_env({"gb": 6.0, "dynamic": False, "optimistic": False})
        == {"OMLX_MOE_OFFLOAD_GB": "6.0"},
    )

    # Auto: GB=auto + dynamic sizing + a prefill-aware safety reserve (so the auto-sized
    # cache leaves upfront room for the prefill memory guard, which preflights before the
    # shrink-controller can react).
    check(
        "auto sets GB=auto + DYNAMIC + SAFETY",
        r.offload_env({"gb": "auto", "dynamic": True, "optimistic": False})
        == {
            "OMLX_MOE_OFFLOAD_GB": "auto",
            "OMLX_MOE_OFFLOAD_DYNAMIC": "1",
            "OMLX_MOE_OFFLOAD_SAFETY_GIB": str(r.OFFLOAD_SAFETY_GIB),
        },
    )
    check("safety reserve leaves real prefill headroom (>= 3 GiB)", r.OFFLOAD_SAFETY_GIB >= 3.0)

    # Optimistic decode opt-in rides alongside a cache.
    check(
        "optimistic sets OPTIMISTIC",
        r.offload_env({"gb": 8.0, "dynamic": False, "optimistic": True})
        == {"OMLX_MOE_OFFLOAD_GB": "8.0", "OMLX_MOE_OPTIMISTIC": "1"},
    )

    # Optimistic is inert when offload is off.
    check(
        "optimistic moot when off",
        r.offload_env({"gb": 0.0, "dynamic": True, "optimistic": True}) == {},
    )

    # Every var offload_env can SET must also be in the managed (pop) set, so toggling
    # a setting off clears its stale inherited value instead of shadowing the config.
    for k in r.offload_env({"gb": "auto", "dynamic": True, "optimistic": True}):
        check(f"{k} is managed (pop-on-off)", k in r.MANAGED_OFFLOAD_ENV)

    print("\nALL PASSED")


if __name__ == "__main__":
    main()
