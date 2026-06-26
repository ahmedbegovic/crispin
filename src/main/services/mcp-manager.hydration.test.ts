import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { mcpServerSchema } from '@shared/ipc'

vi.mock('./logger', () => ({
  scopedLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
  initLogging: () => {},
  log: { info: () => {}, warn: () => {}, error: () => {} }
}))

import { openDatabase } from './db'
import { McpManager } from './mcp-manager'

let dir: string
let db: ReturnType<typeof openDatabase>

const insertServer = (row: {
  id: string
  name: string
  transport: string
  command: string | null
  args: string | null
  url: string | null
  env: string | null
  enabled: number
  scope: string
}): void => {
  db.prepare(
    `INSERT INTO mcp_servers (id, name, transport, command, args, url, env, enabled, scope)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.name,
    row.transport,
    row.command,
    row.args,
    row.url,
    row.env,
    row.enabled,
    row.scope
  )
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crispin-mcp-'))
  db = openDatabase(join(dir, 'test.db'))
})

afterEach(() => {
  try {
    db.close()
  } catch {
    // already closed
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('McpManager.list — hydration', () => {
  it('coerces malformed args/env to empty, drops a server with a bad enum, and stays contract-valid', () => {
    insertServer({ id: 's1', name: 'good', transport: 'stdio', command: 'echo', args: '["--x"]', url: null, env: '{}', enabled: 1, scope: 'chat' })
    insertServer({ id: 's2', name: 'badargs', transport: 'stdio', command: 'echo', args: '[1,2]', url: null, env: '"nope"', enabled: 1, scope: 'chat' })
    insertServer({ id: 's3', name: 'badenum', transport: 'bogus', command: 'echo', args: '[]', url: null, env: '{}', enabled: 1, scope: 'chat' })

    const list = new McpManager(db).list()

    // s3 (transport outside the enum) is dropped; s1 + s2 survive.
    expect(list.map((s) => s.id).sort()).toEqual(['s1', 's2'])
    // s2's non-string-array args and non-record env are coerced to the fallbacks.
    const s2 = list.find((s) => s.id === 's2')!
    expect(s2.args).toEqual([])
    expect(s2.env).toEqual({})
    // The whole list conforms to the contract.
    expect(z.array(mcpServerSchema).safeParse(list).success).toBe(true)
  })
})
