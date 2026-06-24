#!/usr/bin/env node
/**
 * chat-eval-router — regression gate for the pure heuristic web-route pre-router.
 *
 * Unlike the old mirrored chat-eval scripts, this imports the REAL module
 * (src/main/services/chat/search-router-core.ts) directly — Node strips the
 * TypeScript types at load. Keep search-router-core.ts dependency-free so this
 * import never pulls in electron.
 *
 * Usage: node scripts/chat-eval-router.mjs
 * Exits non-zero on any mismatch so it can gate a prompt/heuristic change.
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { heuristicRoute } = await import(
  join(ROOT, 'src/main/services/chat/search-router-core.ts')
)

/** { text, prior?, kind, reason? } — prior = a prior assistant turn used web. */
const CASES = [
  // code → direct
  { text: '```js\nfetch("https://api.example.com")\n```\nwhy is this slow?', kind: 'direct', reason: 'code' },
  { text: 'fix this:\n```py\nprint(x)\n```', kind: 'direct', reason: 'code' },
  // pasted URL(s) → visit
  { text: 'summarize https://example.com/post', kind: 'visit' },
  { text: 'compare https://a.com and https://b.com/page', kind: 'visit' },
  { text: 'read (https://en.wikipedia.org/wiki/Foo_(disambiguation))', kind: 'visit' },
  // pleasantries → direct
  { text: 'thanks!', kind: 'direct', reason: 'pleasantry' },
  { text: 'ok', kind: 'direct', reason: 'pleasantry' },
  { text: 'good morning', kind: 'direct', reason: 'pleasantry' },
  // image intent → direct (image_search lives in the loop)
  { text: 'show me photos of the eiffel tower', kind: 'direct', reason: 'image' },
  { text: 'find pictures of red pandas', kind: 'direct', reason: 'image' },
  // everything else → model micro-call
  { text: 'what is the weather in Paris today', kind: 'model', forceSearch: false },
  { text: 'who won the match last night', kind: 'model', forceSearch: false },
  { text: 'explain how a transformer works', kind: 'model', forceSearch: false },
  { text: 'write me a haiku about autumn', kind: 'model', forceSearch: false },
  // short follow-up after a searched turn → model, forceSearch
  { text: 'what about Montreal?', prior: true, kind: 'model', forceSearch: true },
  { text: 'and tomorrow?', prior: true, kind: 'model', forceSearch: true },
  // a long message after a searched turn is NOT treated as an anaphoric follow-up
  {
    text: 'thanks, now can you explain in detail the historical background of that whole topic please',
    prior: true,
    kind: 'model',
    forceSearch: false
  }
]

let pass = 0
const failures = []
for (const c of CASES) {
  const got = heuristicRoute(c.text, c.prior ?? false)
  const kindOk = got.kind === c.kind
  const reasonOk = c.reason === undefined || got.reason === c.reason
  const forceOk = c.forceSearch === undefined || got.forceSearch === c.forceSearch
  if (kindOk && reasonOk && forceOk) {
    pass++
  } else {
    failures.push({ text: c.text.slice(0, 50), expected: c, got })
  }
}

console.log(`heuristic router: ${pass}/${CASES.length} passed`)
for (const f of failures) {
  console.log(`  ✗ "${f.text}…"`)
  console.log(`    expected ${JSON.stringify({ kind: f.expected.kind, reason: f.expected.reason, forceSearch: f.expected.forceSearch })}`)
  console.log(`    got      ${JSON.stringify(f.got)}`)
}
process.exit(failures.length === 0 ? 0 : 1)
