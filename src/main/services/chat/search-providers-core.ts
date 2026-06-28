/**
 * Pure, dependency-free detection of questions that a STRUCTURED provider answers
 * better than generic web search: package versions (PyPI / npm), GitHub releases,
 * and arXiv papers. High precision on purpose — each detector demands an explicit
 * ecosystem cue (the word "pypi"/"pip", "npm", "github", or an arXiv id), so an
 * ambiguous "latest version of X" falls through to normal search rather than
 * guessing the wrong registry. A miss returns null and changes nothing.
 *
 * Kept import-free so the standalone eval and unit tests can load it without
 * pulling in electron/engine, mirroring search-router-core.
 */

export type ProviderQuery =
  | { kind: 'pypi'; name: string }
  | { kind: 'npm'; name: string }
  | { kind: 'arxiv'; name: string }
  | { kind: 'github_release'; owner: string; repo: string }

/** Tokens that are never a real package/owner name (so a regex can't grab them). */
const NOT_A_NAME = new Set([
  'install', 'the', 'a', 'an', 'latest', 'newest', 'current', 'version', 'versions',
  'package', 'packages', 'release', 'releases', 'of', 'on', 'for', 'in', 'is', 'what',
  'whats', 'show', 'get', 'find', 'me', 'to', 'and', 'or', 'with', 'using', 'use', 'this',
  'that', 'it', 'module', 'library', 'lib', 'repo', 'repository', 'project', 'tag', 'tags'
])

const RELEASE_INTENT_RE = /\b(release|releases|latest|newest|version|versions|tag|tags|changelog|update[ds]?)\b/i

const nameOk = (s: string | undefined): s is string =>
  !!s && s.length <= 100 && !s.includes('..') && !NOT_A_NAME.has(s.toLowerCase()) && /[a-z0-9]/i.test(s)

const stripGit = (repo: string): string => repo.replace(/\.git$/i, '')

/**
 * Classify a user message into a structured-provider lookup, or null. Order:
 * arXiv id (most distinctive) → GitHub release → PyPI → npm.
 */
export function detectProvider(question: string): ProviderQuery | null {
  const t = question.trim()
  if (!t || t.includes('```')) return null

  // arXiv: an explicit "arxiv" word with an id, or a bare arXiv id pattern when
  // "arxiv" is mentioned anywhere (the NNNN.NNNNN form is unambiguous).
  const arxiv =
    /\barxiv[:\s]*?(\d{4}\.\d{4,5})(?:v\d+)?\b/i.exec(t) ??
    (/\barxiv\b/i.test(t) ? /\b(\d{4}\.\d{4,5})(?:v\d+)?\b/.exec(t) : null)
  if (arxiv) return { kind: 'arxiv', name: arxiv[1] }

  // GitHub release: an owner/repo (bare or in a github.com URL) plus a github
  // cue and release intent — so a pasted repo URL for reading still visits.
  if (/\bgithub\b/i.test(t) || /github\.com/i.test(t)) {
    const m = /(?:github\.com\/)?([a-z0-9][\w.-]*)\/([a-z0-9][\w.-]*)/i.exec(t)
    if (m && RELEASE_INTENT_RE.test(t)) {
      const owner = m[1]
      const repo = stripGit(m[2])
      if (nameOk(owner) && nameOk(repo)) return { kind: 'github_release', owner, repo }
    }
  }

  // PyPI / npm require the SAME release/version intent github does — otherwise a
  // troubleshooting prompt ("why does npm install sharp fail on macOS?") gets
  // hijacked into a version lookup and never reaches search. The npm capture
  // allows at most one leading @scope/ slash (no deeper path), so a crafted name
  // can't widen the registry URL path.
  if (RELEASE_INTENT_RE.test(t)) {
    const pypi =
      /\bpip\s+install\s+([a-z0-9][a-z0-9._-]*)/i.exec(t) ??
      /\bpypi\b[\s:]*([a-z0-9][a-z0-9._-]*)/i.exec(t) ??
      /\b([a-z0-9][a-z0-9._-]*)\s+(?:package\s+)?(?:on\s+)?pypi\b/i.exec(t)
    if (pypi && nameOk(pypi[1])) return { kind: 'pypi', name: pypi[1] }

    const npmName = '((?:@[a-z0-9][a-z0-9._-]*\\/)?[a-z0-9][a-z0-9._-]*)'
    const npm =
      new RegExp(`\\bnpm\\s+(?:install\\s+|i\\s+)?${npmName}`, 'i').exec(t) ??
      new RegExp(`\\b${npmName}\\s+(?:package\\s+)?(?:on\\s+)?npm\\b`, 'i').exec(t)
    if (npm && nameOk(npm[1].replace(/^@[^/]+\//, ''))) return { kind: 'npm', name: npm[1] }
  }

  return null
}
