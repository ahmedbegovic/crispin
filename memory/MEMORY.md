# Memory

## Built

- 2026-07-07: Chat run status now enters `generating` only after a streamed assistant message has non-empty answer text. Reasoning, tool calls, tool results, sources, and empty text placeholders stay in `waitingFirstToken`.

## Learned

- `src/renderer/src/tabs/chat/runStatus.ts` is the narrow seam for Chat UI run-phase semantics shared by the thread, assistant row, and composer footer.
- For Chat status UI, visible answer readiness is not the same as `message.parts.length > 0`; process parts can arrive before answer text.
- Validation for this renderer path is `npm test -- src/renderer/src/tabs/chat/runStatus.test.ts`, `npm run typecheck`, `npm test`, `npm run build`, and `git diff --check`.
