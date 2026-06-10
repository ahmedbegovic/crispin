import { useState } from 'react'
import { Loader2, Pencil, Plus, PlugZap, Trash2 } from 'lucide-react'
import type { McpScope, McpServer, McpTransport } from '@shared/types'
import { useMcpStore } from '@/stores/mcp'
import { toastError } from '@/stores/toasts'
import ConfirmDialog from '@/components/ConfirmDialog'
import Modal from './Modal'

interface McpForm {
  id: string | null
  name: string
  transport: McpTransport
  command: string
  args: string
  url: string
  env: string
  scope: McpScope
  enabled: boolean
}

const EMPTY_FORM: McpForm = {
  id: null,
  name: '',
  transport: 'stdio',
  command: '',
  args: '',
  url: '',
  env: '',
  scope: 'chat',
  enabled: true
}

function toForm(server: McpServer): McpForm {
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    command: server.command ?? '',
    args: server.args.join(' '),
    url: server.url ?? '',
    env: Object.entries(server.env)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
    scope: server.scope,
    enabled: server.enabled
  }
}

function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return env
}

const inputClass =
  'w-full rounded-md border border-zinc-800 bg-zinc-950/60 px-2 py-1 text-[12px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-zinc-600'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] text-zinc-500">{label}</span>
      {children}
    </label>
  )
}

export default function McpDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const servers = useMcpStore((s) => s.servers)
  const testing = useMcpStore((s) => s.testing)
  const testResults = useMcpStore((s) => s.testResults)
  const upsert = useMcpStore((s) => s.upsert)
  const remove = useMcpStore((s) => s.remove)
  const toggle = useMcpStore((s) => s.toggle)
  const test = useMcpStore((s) => s.test)

  const [form, setForm] = useState<McpForm | null>(null)
  const [removeTarget, setRemoveTarget] = useState<McpServer | null>(null)

  const canSave =
    form !== null &&
    form.name.trim().length > 0 &&
    (form.transport === 'stdio' ? form.command.trim().length > 0 : form.url.trim().length > 0)

  const save = (): void => {
    if (!form || !canSave) return
    const server: McpServer = {
      id: form.id ?? crypto.randomUUID(),
      name: form.name.trim(),
      transport: form.transport,
      command: form.transport === 'stdio' ? form.command.trim() : null,
      args: form.args.trim() ? form.args.trim().split(/\s+/) : [],
      url: form.transport === 'http' ? form.url.trim() : null,
      env: parseEnv(form.env),
      enabled: form.enabled,
      scope: form.scope
    }
    void upsert(server)
      .then(() => setForm(null))
      .catch(toastError)
  }

  return (
    <Modal open={open} title="MCP servers" onClose={onClose}>
      {form ? (
        <div className="flex flex-col gap-3">
          <Field label="Name">
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="github"
              spellCheck={false}
              autoFocus
              className={inputClass}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Transport">
              <select
                value={form.transport}
                onChange={(e) => setForm({ ...form, transport: e.target.value as McpTransport })}
                className={inputClass}
              >
                <option value="stdio">stdio</option>
                <option value="http">http</option>
              </select>
            </Field>
            <Field label="Scope">
              <select
                value={form.scope}
                onChange={(e) => setForm({ ...form, scope: e.target.value as McpScope })}
                className={inputClass}
              >
                <option value="chat">chat</option>
                <option value="agent">agent</option>
                <option value="both">both</option>
              </select>
            </Field>
          </div>
          {form.transport === 'stdio' ? (
            <>
              <Field label="Command">
                <input
                  value={form.command}
                  onChange={(e) => setForm({ ...form, command: e.target.value })}
                  placeholder="npx"
                  spellCheck={false}
                  className={inputClass}
                />
              </Field>
              <Field label="Arguments (space-separated)">
                <input
                  value={form.args}
                  onChange={(e) => setForm({ ...form, args: e.target.value })}
                  placeholder="-y @modelcontextprotocol/server-everything"
                  spellCheck={false}
                  className={inputClass}
                />
              </Field>
            </>
          ) : (
            <Field label="URL">
              <input
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                placeholder="http://127.0.0.1:3001/mcp"
                spellCheck={false}
                className={inputClass}
              />
            </Field>
          )}
          <Field label="Environment (KEY=value per line)">
            <textarea
              value={form.env}
              onChange={(e) => setForm({ ...form, env: e.target.value })}
              rows={3}
              spellCheck={false}
              className={`${inputClass} resize-none font-mono`}
            />
          </Field>
          <label className="flex items-center gap-2 text-[12px] text-zinc-300">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />
            Enabled
          </label>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setForm(null)}
              className="rounded-md px-2.5 py-1 text-[12px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={!canSave}
              className="rounded-md bg-emerald-600 px-2.5 py-1 text-[12px] font-medium text-white enabled:hover:bg-emerald-500 disabled:opacity-40"
            >
              Save
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {servers.length === 0 && (
            <p className="text-[12px] text-zinc-500">
              No MCP servers configured. Add one to expose its tools to chat.
            </p>
          )}
          {servers.map((server) => {
            const result = testResults[server.id]
            return (
              <div
                key={server.id}
                className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => void toggle(server.id, !server.enabled).catch(toastError)}
                    title={server.enabled ? 'Disable' : 'Enable'}
                    className={`h-4 w-7 shrink-0 rounded-full transition-colors ${
                      server.enabled ? 'bg-emerald-600' : 'bg-zinc-700'
                    }`}
                  >
                    <span
                      className={`block h-3 w-3 rounded-full bg-white transition-transform ${
                        server.enabled ? 'translate-x-3.5' : 'translate-x-0.5'
                      }`}
                    />
                  </button>
                  <span className="truncate text-[12.5px] text-zinc-200">{server.name}</span>
                  <span className="rounded border border-zinc-700/80 px-1 text-[9px] uppercase tracking-wide text-zinc-500">
                    {server.transport}
                  </span>
                  <span className="rounded border border-zinc-700/80 px-1 text-[9px] uppercase tracking-wide text-zinc-500">
                    {server.scope}
                  </span>
                  <div className="ml-auto flex shrink-0 items-center gap-0.5">
                    <button
                      onClick={() => void test(server.id)}
                      title="Test connection"
                      className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                    >
                      {testing[server.id] ? (
                        <Loader2 size={13} className="animate-spin" />
                      ) : (
                        <PlugZap size={13} />
                      )}
                    </button>
                    <button
                      onClick={() => setForm(toForm(server))}
                      title="Edit"
                      className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      onClick={() => setRemoveTarget(server)}
                      title="Remove"
                      className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
                <div className="mt-0.5 truncate text-[11px] text-zinc-600">
                  {server.transport === 'stdio'
                    ? `${server.command ?? ''} ${server.args.join(' ')}`.trim()
                    : server.url}
                </div>
                {result &&
                  (result.ok ? (
                    <div className="mt-1 select-text text-[11px] text-emerald-400">
                      {result.tools && result.tools.length > 0
                        ? `Tools: ${result.tools.join(', ')}`
                        : 'Connected — no tools reported.'}
                    </div>
                  ) : (
                    <div className="mt-1 select-text text-[11px] text-red-400">
                      {result.error ?? 'Connection failed.'}
                    </div>
                  ))}
              </div>
            )
          })}
          <button
            onClick={() => setForm(EMPTY_FORM)}
            className="flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-zinc-700 py-1.5 text-[12px] text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
          >
            <Plus size={13} />
            Add server
          </button>
        </div>
      )}

      <ConfirmDialog
        open={removeTarget !== null}
        title="Remove MCP server"
        body={`Remove "${removeTarget?.name ?? ''}"? Its tools will disappear from chat.`}
        confirmLabel="Remove"
        danger
        onConfirm={() => {
          if (removeTarget) void remove(removeTarget.id).catch(toastError)
          setRemoveTarget(null)
        }}
        onCancel={() => setRemoveTarget(null)}
      />
    </Modal>
  )
}
