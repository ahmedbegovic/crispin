# Crispin

Personal macOS desktop app for using local LLMs via MLX. Electron + React + TS shell,
two uv-managed Python sidecars, opencode embedded for agentic tabs. Single user, no auth.
Apple Silicon only; dev machine has 24GB unified memory — RAM headroom is the core constraint.

## Commands

- `npm run dev` — launch app in dev (electron-vite; renderer HMR, main rebuilt on change)
- `npm run typecheck` — `tsc --noEmit`; keep this clean
- `npm test` — `vitest run` (unit tests; `npm run test:watch` to iterate). CI runs typecheck + test on push/PR (`.github/workflows/ci.yml`); keep both green before pushing.
- `npm run rebuild` — rebuild native modules (node-pty) after Electron upgrades
- `uv sync` inside `sidecars/tools` or `sidecars/engine` — sync sidecar venvs
- `npm run dist` — package DMG (M6+)

## Architecture

- `src/shared/ipc.ts` — the typed IPC contract (zod). Renderer calls `window.crispin.call(method, input)`;
  main pushes events on one channel. Every new feature extends this contract first, then adds a handler in
  `src/main/features/*.ts` (one `registerXFeature(deps)` per domain, wired in `src/main/index.ts`);
  `src/main/ipc/router.ts` validates input against the contract and dispatches, events go out via `src/main/ipc/events.ts`.
- `src/main/services/process-manager.ts` — supervises sidecars (spawn/health/backoff/restart,
  process-group kills). Engine restarts are a feature (model swap), not a failure.
- Sidecars: `engine` (oMLX, OpenAI-compatible, preferred port 47621) and `tools`
  (FastAPI: downloads/extract/RAG/search/news, preferred port 47622). Ports are dynamic —
  always resolve via the port allocator, never hardcode.
- SQLite via built-in `node:sqlite` (NOT better-sqlite3 — it doesn't compile against current
  Electron). Migrations in `src/main/services/db/migrations/*.sql`, applied by user_version.
- Model policy lives in `src/shared/model-tiers.ts`. Gemma 4 quants MUST be `qat` variants —
  non-QAT MLX quants produce garbage output (PLE quantization bug). Don't bypass `validateModelRepo`
  in code; the only sanctioned escape hatches are `NON_QAT_GEMMA_WHITELIST` (auto-accepted — the 31B
  regular 4-bit quant; the PLE bug concerns the E-series, so the 31B is fine) and the user-confirmed
  `force` flag on `models.download` (the UI confirms first).

## Conventions

- Main process owns all orchestration; renderer never talks to sidecars directly.
- Long sidecar jobs return `{job_id}`; poll `GET /jobs/{id}`.
- Timestamps: unix ms. Ids: `crypto.randomUUID()`.
- Imports use path aliases `@shared/*`, `@main/*`, `@/*` (renderer); defined in `tsconfig.json`, mirrored in `vitest.config.ts`.
- App data: `~/Library/Application Support/Crispin/` (db, logs, reports, skills, memory).
  Model weights stay in the shared HF cache (`~/.cache/huggingface/hub`).
