# Orion

Personal macOS desktop app for using local LLMs via MLX. Electron + React + TS shell,
two uv-managed Python sidecars, opencode embedded for agentic tabs. Single user, no auth.
Apple Silicon only; dev machine has 24GB unified memory — RAM headroom is the core constraint.

## Commands

- `npm run dev` — launch app in dev (electron-vite; renderer HMR, main rebuilt on change)
- `npm run typecheck` — `tsc --noEmit`; keep this clean
- `npm run rebuild` — rebuild native modules (node-pty) after Electron upgrades
- `uv sync` inside `sidecars/tools` or `sidecars/engine` — sync sidecar venvs
- `npm run dist` — package DMG (M6+)

## Architecture (see ~/.claude/plans/i-want-to-create-witty-flamingo.md for the full plan)

- `src/shared/ipc.ts` — the typed IPC contract (zod). Renderer calls `window.orion.call(method, input)`;
  main pushes events on one channel. Every new feature extends this contract first.
- `src/main/services/process-manager.ts` — supervises sidecars (spawn/health/backoff/restart,
  process-group kills). Engine restarts are a feature (model swap), not a failure.
- Sidecars: `engine` (oMLX, OpenAI-compatible, preferred port 47621) and `tools`
  (FastAPI: downloads/extract/RAG/search/news, preferred port 47622). Ports are dynamic —
  always resolve via the port allocator, never hardcode.
- SQLite via built-in `node:sqlite` (NOT better-sqlite3 — it doesn't compile against current
  Electron). Migrations in `src/main/services/db/migrations/*.sql`, applied by user_version.
- Model policy lives in `src/shared/model-tiers.ts`. Gemma 4 quants MUST be `qat` variants —
  non-QAT MLX quants produce garbage output (PLE quantization bug). Never bypass the validator.

## Conventions

- Main process owns all orchestration; renderer never talks to sidecars directly.
- Long sidecar jobs return `{job_id}`; poll `GET /jobs/{id}`.
- Timestamps: unix ms. Ids: `crypto.randomUUID()`.
- App data: `~/Library/Application Support/Orion/` (db, logs, reports, skills, memory).
  Model weights stay in the shared HF cache (`~/.cache/huggingface/hub`).
