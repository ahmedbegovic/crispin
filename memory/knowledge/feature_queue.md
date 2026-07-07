# Feature Queue

## Queue

### [P1] Add feedback for sidebar copy/export failures

- Problem: sidebar copy/export actions call IPC fire-and-forget, so failures can be silent.
- Proposed feature: surface success/failure toasts for conversation copy/export actions.
- User value: users know whether an export or clipboard action actually completed.
- Acceptance criteria: copy/export errors show a toast, success states are clear, and existing menu behavior is unchanged.
- Estimated effort: small.
- Impact: medium.
- Coverage: chat sidebar users.
- Risk: low, renderer-only.
- Files likely affected: `src/renderer/src/tabs/chat/ConversationSidebar.tsx`.
- Verification plan: focused manual interaction, `npm run typecheck`, `npm test`, `git diff --check`.

### [P2] Expand find-in-conversation over visible activity labels

- Problem: find currently searches text parts only, so visible tool/source activity labels are not discoverable.
- Proposed feature: include visible activity/source labels in the local conversation search index.
- User value: users can locate web/tool-backed turns more reliably.
- Acceptance criteria: find still scrolls to the right row, text matching remains unchanged, and tool/source labels can match.
- Estimated effort: small to medium.
- Impact: medium.
- Coverage: users of long chat threads with tools or RAG.
- Risk: low to medium, because search semantics can surprise users if broadened too far.
- Files likely affected: `src/renderer/src/tabs/chat/Thread.tsx`, activity/source render helpers.
- Verification plan: focused component/manual checks, `npm run typecheck`, `npm test`.

## Completed

### 2026-07-07 - Chat run status answer readiness

- Problem: the Chat UI treated any streamed assistant part as `generating`, including reasoning, tool calls, tool results, sources, or empty text placeholders before visible answer text existed.
- Proposed feature: classify `generating` only after non-empty answer text streams; keep process-only activity in `waitingFirstToken`/`Thinking...`.
- User value: loading and thinking states stay truthful during reasoning/tool work, and empty answers do not expose response-copy controls prematurely.
- Acceptance criteria: process-only parts remain `waitingFirstToken`; empty text remains `waitingFirstToken`; non-empty text becomes `generating`; existing starting/loading/stopping behavior is unchanged.
- Impact: high.
- Coverage: all Chat conversations that stream reasoning, tools, web/RAG sources, or delayed answer text.
- Risk: low, isolated to renderer run-phase classification.
- Files affected: `src/renderer/src/tabs/chat/runStatus.ts`, `src/renderer/src/tabs/chat/runStatus.test.ts`.
- Verification: `npm test -- src/renderer/src/tabs/chat/runStatus.test.ts`, `npm run typecheck`, `npm test`, `npm run build`, `git diff --check`.
- PR: pending.

## Rejected

None yet.

## Needs Product Decision

None yet.
