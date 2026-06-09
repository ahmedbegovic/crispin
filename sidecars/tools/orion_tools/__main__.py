import argparse

import uvicorn


def main() -> None:
    parser = argparse.ArgumentParser(prog="orion-tools")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=47622)
    args = parser.parse_args()

    uvicorn.run(
        "orion_tools.main:app",
        host=args.host,
        port=args.port,
        log_level="info",
        access_log=False,
    )


if __name__ == "__main__":
    main()
