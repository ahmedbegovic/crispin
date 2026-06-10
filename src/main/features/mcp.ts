import { handle } from '../ipc/router'
import type { McpManager } from '../services/mcp-manager'

/** Registers every mcp.* IPC method. */
export function registerMcpFeature(mcp: McpManager): void {
  handle('mcp.list', () => ({ servers: mcp.list() }))

  handle('mcp.upsert', ({ server }) => ({ server: mcp.upsert(server) }))

  handle('mcp.remove', ({ id }) => {
    mcp.remove(id)
    return { ok: true }
  })

  handle('mcp.test', ({ id }) => mcp.test(id))
}
