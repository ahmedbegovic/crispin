# Crispin

Personal macOS desktop app for running local LLMs via [MLX](https://github.com/ml-explore/mlx).
Electron + React + TypeScript shell with two uv-managed Python sidecars:
an OpenAI-compatible inference server ([oMLX](https://github.com/jundot/omlx)) and a
FastAPI tools service (model downloads, document extraction, RAG, web search, news).
Agentic coding tabs are powered by an embedded [opencode](https://opencode.ai) instance.

It's optimized primarily for the Gemma and Qwen model families, while still
supporting any other MLX-compatible model you choose to run.

> Built for a single user on Apple Silicon. No auth, no telemetry — everything runs
> on-device; model weights live in the shared Hugging Face cache
> (`~/.cache/huggingface/hub`).

## Features

  **Chat** — Streaming local chat with collapsible reasoning, optional web search, and RAG over your document
  collections.

  <img width="2168" height="1314" alt="Screenshot 2026-06-11 at 2 30 57 AM" src="https://github.com/user-attachments/assets/8a21e5a2-f624-4d46-8a8b-f297f370fbb8" />

  **Agentic coding** — An embedded opencode agent works in a real project: file tree, Monaco editor, integrated
  terminal, and a live step-by-step log.

  <img width="2168" height="1314" alt="Screenshot 2026-06-11 at 2 27 57 AM" src="https://github.com/user-attachments/assets/b84ee156-3db7-4488-9ff2-04ee984c466b" />

  **Research** — Multi-round deep research that gathers sources and writes a cited, exportable report (PDF).

  <img width="2168" height="1314" alt="Screenshot 2026-06-11 at 2 26 30 AM" src="https://github.com/user-attachments/assets/851fc8c7-ba1f-476a-9112-4e3a3c284ffc" />

  **Models** — Choose models by tier (Low→Ultra) with live RAM-budget checks, set per-feature defaults, manage what's on
  disk, and search Hugging Face.                                                                       

  <img width="2168" height="1314" alt="Screenshot 2026-06-11 at 2 10 55 AM" src="https://github.com/user-attachments/assets/9e5a6871-de22-428f-b490-20be4aa2750d" />

## Requirements

- macOS on Apple Silicon (developed on an M4 Pro with 24 GB unified memory)
- Node 22+ and npm
- [uv](https://docs.astral.sh/uv/) (Python 3.12+ sidecar venvs are synced with it)

## Development

```sh
npm install
uv sync --project sidecars/engine
uv sync --project sidecars/tools
npm run dev        # electron-vite dev: renderer HMR, main rebuilt on change
```

Other commands:

- `npm run typecheck` — `tsc --noEmit`
- `npm run rebuild` — rebuild native modules (node-pty) after Electron upgrades
- `npm run dist` — package a DMG (arm64)

## Architecture

- `src/shared/ipc.ts` — typed (zod) IPC contract between renderer and main;
  the renderer never talks to the sidecars directly
- `src/main/services/` — orchestration: sidecar supervision, model tiers,
  chat pipeline, SQLite (via `node:sqlite`) with versioned migrations
- `sidecars/engine` — oMLX OpenAI-compatible multi-model server (dynamic port)
- `sidecars/tools` — FastAPI: downloads, extraction, RAG (LanceDB), search, news
- `resources/skills/` — skill packs that ship with the app, copied into app data
  on first run so they can be customized

App data lives in `~/Library/Application Support/Crispin/`.

## Acknowledgements

Crispin is built on excellent open-source work:

- [oMLX](https://github.com/jundot/omlx) — the OpenAI-compatible MLX inference
  server Crispin embeds as its engine backend (Apache-2.0). Crispin runs a small,
  lightly-patched fork; it began from [vllm-mlx](https://github.com/waybarrios/vllm-mlx).
- [MLX](https://github.com/ml-explore/mlx) and
  [mlx-lm](https://github.com/ml-explore/mlx-lm) by Apple — the array framework and
  LLM inference that the engine runs on.
- [mlx-vlm](https://github.com/Blaizzy/mlx-vlm) and
  [mlx-embeddings](https://github.com/Blaizzy/mlx-embeddings) — vision-language and
  embedding model inference on Apple Silicon.
- [dflash-mlx](https://github.com/bstnxbt/dflash-mlx) — block-diffusion speculative
  decoding on Apple Silicon.
- [opencode](https://opencode.ai) — powers the agentic coding tabs.
- The tools sidecar builds on [trafilatura](https://github.com/adbar/trafilatura),
  [LanceDB](https://github.com/lancedb/lancedb),
  [pymupdf4llm](https://github.com/pymupdf/RAG), ddgs, and feedparser.

## License

[MIT](LICENSE)
