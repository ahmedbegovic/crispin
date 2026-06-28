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
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// pathToFileURL so the absolute path is a valid file:// URL on Windows too
// (a bare `C:\…` path trips the ESM loader's URL-scheme check).
const { heuristicRoute } = await import(
  pathToFileURL(join(ROOT, 'src/main/services/chat/search-router-core.ts')).href
)

/** { text, prior?, kind, reason?, forceSearch?, freshHint? } — prior = a prior assistant turn used web. */
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
  // deterministic no-search classes → direct (same outcome the model would reach)
  { text: 'what is 2+2', kind: 'direct', reason: 'no_search_class' },
  { text: '3 * (4 + 5)', kind: 'direct', reason: 'no_search_class' },
  { text: 'translate hello to French', kind: 'direct', reason: 'no_search_class' },
  { text: 'convert 5 km to miles', kind: 'direct', reason: 'no_search_class' },
  // a freshness cue OVERRIDES the no-search class (still routes to the model)
  { text: 'translate the latest headline to French', kind: 'model', forceSearch: false, freshHint: true },
  // freshness floor → model, freshHint true (the micro-call must lean search)
  { text: 'what is the weather in Paris today', kind: 'model', forceSearch: false, freshHint: true },
  { text: 'who won the match last night', kind: 'model', forceSearch: false, freshHint: true },
  { text: 'latest iPhone price', kind: 'model', forceSearch: false, freshHint: true },
  { text: 'summarize the latest news from Apple', kind: 'model', forceSearch: false, freshHint: true },
  // no freshness cue → model, freshHint false
  { text: 'explain how a transformer works', kind: 'model', forceSearch: false, freshHint: false },
  { text: 'write me a haiku about autumn', kind: 'model', forceSearch: false, freshHint: false },
  // short follow-up after a searched turn → model, forceSearch
  { text: 'what about Montreal?', prior: true, kind: 'model', forceSearch: true, freshHint: false },
  { text: 'and tomorrow?', prior: true, kind: 'model', forceSearch: true, freshHint: true },
  // a long message after a searched turn is NOT treated as an anaphoric follow-up
  {
    text: 'thanks, now can you explain in detail the historical background of that whole topic please',
    prior: true,
    kind: 'model',
    forceSearch: false,
    freshHint: false
  }
]

let pass = 0
const failures = []
for (const c of CASES) {
  const got = heuristicRoute(c.text, c.prior ?? false)
  const kindOk = got.kind === c.kind
  const reasonOk = c.reason === undefined || got.reason === c.reason
  const forceOk = c.forceSearch === undefined || got.forceSearch === c.forceSearch
  const freshOk = c.freshHint === undefined || got.freshHint === c.freshHint
  if (kindOk && reasonOk && forceOk && freshOk) {
    pass++
  } else {
    failures.push({ text: c.text.slice(0, 50), expected: c, got })
  }
}

console.log(`heuristic router: ${pass}/${CASES.length} passed`)

// --- routing distribution baseline (3B.0) ------------------------------------
// A cheap, deterministic readout of how the pre-router classifies the corpus —
// the before/after guard for the scope→budget change. A spike in `direct` (the
// pipeline never runs) or a collapse in the search-leaning share flags an
// under-search regression before it reaches a model.
const dist = { direct: 0, visit: 0, model_lean: 0, model_neutral: 0 }
for (const c of CASES) {
  const got = heuristicRoute(c.text, c.prior ?? false)
  if (got.kind === 'direct') dist.direct++
  else if (got.kind === 'visit') dist.visit++
  else if (got.forceSearch || got.freshHint) dist.model_lean++
  else dist.model_neutral++
}
const searchLeaning = dist.visit + dist.model_lean
console.log(
  `routing baseline: direct=${dist.direct} visit=${dist.visit} ` +
    `model(lean)=${dist.model_lean} model(neutral)=${dist.model_neutral} ` +
    `· search-leaning=${searchLeaning}/${CASES.length}`
)

for (const f of failures) {
  console.log(`  ✗ "${f.text}…"`)
  console.log(`    expected ${JSON.stringify({ kind: f.expected.kind, reason: f.expected.reason, forceSearch: f.expected.forceSearch, freshHint: f.expected.freshHint })}`)
  console.log(`    got      ${JSON.stringify(f.got)}`)
}
process.exit(failures.length === 0 ? 0 : 1)
