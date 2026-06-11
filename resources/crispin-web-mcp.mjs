#!/usr/bin/env node
// Stdio MCP server proxying web search/visit to the Crispin tools sidecar.
// Spawned by opencode (config mcp['crispin-web']); CRISPIN_TOOLS_URL carries the
// sidecar base url. Standalone on purpose: plain Node ESM, no imports from
// src/ — bare specifiers resolve against the adjacent node_modules.
// stdout is the protocol channel — never write anything else to it.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const FETCH_TIMEOUT_MS = 60_000

async function toolsPost(path, body) {
  const base = process.env.CRISPIN_TOOLS_URL
  if (!base) throw new Error('CRISPIN_TOOLS_URL is not set')
  const res = await fetch(`${base.replace(/\/+$/, '')}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`tools POST ${path} → ${res.status}: ${text.slice(0, 300)}`)
  }
  return res.json()
}

const textResult = (text) => ({ content: [{ type: 'text', text }] })
const errorResult = (err) => ({
  isError: true,
  content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }]
})

const server = new McpServer({ name: 'crispin-web', version: '0.1.0' })

server.registerTool(
  'web_search',
  {
    description: 'Search the web. Returns result titles, urls and snippets.',
    inputSchema: {
      query: z.string().describe('The search query'),
      max_results: z.number().int().min(1).max(20).optional().describe('Maximum results (default 8)')
    }
  },
  async ({ query, max_results }) => {
    try {
      // → routers/web.py SearchRequest; response {results: [{title, url, snippet}], backend}
      const body = { query }
      if (max_results !== undefined) body.max_results = max_results
      const { results } = await toolsPost('/search', body)
      if (results.length === 0) return textResult('No results.')
      return textResult(
        results
          .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`)
          .join('\n\n')
      )
    } catch (err) {
      return errorResult(err)
    }
  }
)

server.registerTool(
  'web_visit',
  {
    description: 'Fetch a web page and return its main content as markdown.',
    inputSchema: {
      url: z.string().describe('Absolute http(s) url of the page to read')
    }
  },
  async ({ url }) => {
    try {
      // → routers/web.py VisitRequest (sidecar truncates at its max_chars
      // default); response {markdown, title, url}
      const page = await toolsPost('/visit', { url })
      const heading = page.title ? `# ${page.title}\n\n` : ''
      return textResult(`${heading}${page.markdown}\n\nSource: ${page.url}`)
    } catch (err) {
      return errorResult(err)
    }
  }
)

// --- cross-model consultation (P2-14) ---------------------------------------
// Same server, no new process. opencode runs tools BETWEEN generations, so the
// host model is never mid-stream while we swap models; oMLX lazily reloads the
// host model on its next turn, and main's auto-swap covers the app side.

const ENGINE_STATUS_TIMEOUT_MS = 15_000
const CONSULT_TIMEOUT_MS = 10 * 60_000

function engineBase() {
  const base = process.env.CRISPIN_ENGINE_URL
  if (!base) throw new Error('CRISPIN_ENGINE_URL is not set')
  return base.replace(/\/+$/, '')
}

/** tier -> { modelId (engine id), estGB, label }; written by opencode-config. */
function tierMap() {
  try {
    return JSON.parse(process.env.CRISPIN_TIER_MAP ?? '{}')
  } catch {
    return {}
  }
}

async function engineFetch(path, init, timeoutMs) {
  const res = await fetch(`${engineBase()}${path}`, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`engine ${path} → ${res.status}: ${text.slice(0, 300)}`)
  }
  return res.json()
}

server.registerTool(
  'list_tiers',
  {
    description:
      'List the locally installed model tiers available to consult_model (label, model id, estimated RAM).',
    inputSchema: {}
  },
  async () => {
    try {
      const map = tierMap()
      const tiers = Object.entries(map)
      if (tiers.length === 0) return textResult('No tiers are installed right now.')
      const budget = Number(process.env.CRISPIN_ENGINE_BUDGET_GB ?? '0')
      const lines = tiers.map(
        ([tier, t]) => `- ${tier} (${t.label}): ${t.modelId} — ~${t.estGB} GB`
      )
      if (budget) lines.push(`Memory budget: ${budget} GB.`)
      lines.push('Each consult_model call may take several minutes (model swap).')
      return textResult(lines.join('\n'))
    } catch (err) {
      return errorResult(err)
    }
  }
)

server.registerTool(
  'consult_model',
  {
    description:
      'Ask another locally installed model tier one question and return its full reply. ' +
      'SLOW: the engine may unload/load multi-GB models first — a call can take minutes. ' +
      'Use list_tiers to see what is available; never call this in a loop.',
    inputSchema: {
      tier: z.string().describe('Tier key from list_tiers (e.g. "high")'),
      prompt: z.string().describe('The question for the consulted model'),
      system: z.string().optional().describe('Optional system prompt for the consulted model')
    }
  },
  async ({ tier, prompt, system }) => {
    try {
      const map = tierMap()
      const target = map[tier]
      if (!target) {
        return errorResult(
          new Error(`Unknown tier "${tier}" — installed tiers: ${Object.keys(map).join(', ') || 'none'}`)
        )
      }
      const budget = Number(process.env.CRISPIN_ENGINE_BUDGET_GB ?? '0')
      if (budget && target.estGB > budget) {
        return errorResult(
          new Error(`${target.label} (~${target.estGB} GB) cannot fit the ${budget} GB memory budget on this machine.`)
        )
      }
      // Never yank models out from under a running generation. models_loading
      // counts too: a request parked in a lazy cold load registers in neither
      // active nor waiting (same pitfall engine-client documents).
      const status = await engineFetch('/api/status', undefined, ENGINE_STATUS_TIMEOUT_MS)
      const busy =
        (status.active_requests ?? 0) +
        (status.waiting_requests ?? 0) +
        (status.models_loading ?? 0)
      if (busy > 0) {
        return errorResult(new Error('The engine is busy with another generation — try again shortly.'))
      }
      // Sequential swap: free every OTHER loaded model so the consultee fits.
      // Only real pool models (source_repo_id present) — oMLX appends virtual
      // built-ins like MarkItDown that report loaded but 404 on /unload.
      const { models = [] } = await engineFetch('/v1/models/status', undefined, ENGINE_STATUS_TIMEOUT_MS)
      for (const m of models) {
        if (
          m.loaded &&
          m.id !== target.modelId &&
          typeof m.source_repo_id === 'string' &&
          m.source_repo_id.length > 0
        ) {
          await engineFetch(`/v1/models/${m.id}/unload`, { method: 'POST' }, 120_000)
        }
      }
      const completion = await engineFetch(
        '/v1/chat/completions',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: target.modelId,
            messages: [
              ...(system ? [{ role: 'system', content: system }] : []),
              { role: 'user', content: prompt }
            ],
            stream: false,
            max_tokens: 4096
          })
        },
        CONSULT_TIMEOUT_MS
      )
      const reply = completion.choices?.[0]?.message?.content ?? ''
      if (!reply) return errorResult(new Error('The consulted model returned an empty reply.'))
      return textResult(`[${target.label} — ${target.modelId}]\n\n${reply}`)
    } catch (err) {
      return errorResult(err)
    }
  }
)

try {
  await server.connect(new StdioServerTransport())
} catch (err) {
  console.error(`crispin-web-mcp failed to start: ${err instanceof Error ? err.message : err}`)
  process.exit(1)
}
