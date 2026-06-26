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
  process-group kills). A model *swap* is a per-model `/load`+`/unload` (`engine-client.ts`
  `warm`/`unloadModel`), NOT a restart; engine *restarts* are still a feature (registry/config change —
  a model added to the config, a freshly-downloaded model the engine must rediscover at spawn, a budget
  change), not a failure.
- Sidecars: `engine` (oMLX, OpenAI-compatible, preferred port 47621; also serves the RAG embedder —
  see model policy) and `tools` (FastAPI: downloads/extract/RAG/search/news, preferred port 47622).
  Ports are dynamic — always resolve via the port allocator, never hardcode. The engine is driven by
  `<dataDir>/engine/engine-config.json`, rewritten before every spawn by `engine-config.ts`
  (`writeEngineConfig`) and read by `sidecars/engine/run_engine.py` — which merges Crispin's per-model
  settings into the *shared* `~/.omlx/model_settings.json` (co-owned with the standalone oMLX app:
  last-writer-wins on startup).
- SQLite via built-in `node:sqlite` (NOT better-sqlite3 — it doesn't compile against current
  Electron). Migrations in `src/main/services/db/migrations/*.sql`, applied by user_version.
- Model policy lives in `src/shared/model-tiers.ts`. Gemma 4 quants MUST be `qat` variants —
  non-QAT MLX quants produce garbage output (PLE quantization bug). Don't bypass `validateModelRepo`
  in code; the only sanctioned escape hatches are `NON_QAT_GEMMA_WHITELIST` (auto-accepted — the 31B
  regular 4-bit quant; the PLE bug concerns the E-series, so the 31B is fine) and two user-confirmed,
  UI-gated overrides: `force` on `models.download` and `allowBroken` on `models.load` (separate from
  the RAM-guard `force`). The validator is NOT applied on the internal auto-load path (`ensureLoaded`):
  the name heuristic has false positives, so auto-load honors the user's explicit pick. `model-tiers.ts`
  also owns per-tier RAM policy beyond the QAT gate — TurboQuant KV (`kvQuantBits`), `noCoload`,
  `maxOutputTokens` — and the QAT rule is enforced at three seams (download, load, and discovery via
  `candidateWarning`). The RAG embedder (`EMBEDDING_MODEL`) is served from the engine pool like any
  model (`/v1/embeddings` counts against the memory guard) but is protected from eviction and stays out
  of the chat tiers / registry / Models tab.

## Conventions

- Main process owns all orchestration; renderer never talks to sidecars directly.
- Long sidecar jobs return `{job_id}`; poll `GET /jobs/{id}`.
- Timestamps: unix ms. Ids: `crypto.randomUUID()`.
- Imports use path aliases `@shared/*`, `@main/*`, `@/*` (renderer); defined in `tsconfig.json`, mirrored in `vitest.config.ts`.
- App data: `~/Library/Application Support/Crispin/` (db, logs, reports, skills, memory).
  Model weights stay in the shared HF cache (`~/.cache/huggingface/hub`).
