import { useEffect, useRef, useState } from 'react'
import {
  FileText,
  Globe,
  Image as ImageIcon,
  Paperclip,
  SendHorizontal,
  Settings2,
  Sliders,
  Sparkles,
  Square,
  X
} from 'lucide-react'
import {
  FAMILIES,
  FAMILY_LABELS,
  FEATURE_DEFAULTS,
  TIER_LABELS,
  TIER_ORDER
} from '@shared/model-tiers'
import type { AttachmentInput, Conversation, Family, SkillMeta, Tier } from '@shared/types'
import { call } from '@/lib/ipc'
import { useAutosizeTextarea } from '@/lib/useAutosizeTextarea'
import { useDismissable } from '@/lib/useDismissable'
import { useChatStore } from '@/stores/chat'
import { usePaletteStore } from '@/stores/palette'
import { useLibraryStore } from '@/stores/library'
import { useModelsStore } from '@/stores/models'
import { pushToast, toastError } from '@/stores/toasts'
import { basename, kindForPath, pathForFile } from './attachments'
import McpDialog from './McpDialog'
import LibraryDialog from './LibraryDialog'
import ContextDonut from './ContextDonut'

const FILE_ACCEPT =
  'image/png,image/jpeg,image/webp,image/gif,.pdf,.docx,.pptx,.xlsx,.md,.txt,.html,.csv,.epub'

// Matches the textarea's max-h-44 — the autosize overflow toggle keys off it.
const MAX_TEXTAREA_PX = 176

const MANAGE_SENTINEL = '__manage__'

const selectClass =
  'rounded-md border border-zinc-800 bg-zinc-900 px-1.5 py-1 text-[11px] text-zinc-400 outline-none hover:text-zinc-200 focus:border-zinc-600'

/** Chunked base64 so a multi-MB pasted screenshot doesn't blow the call stack. */
function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

interface Props {
  conversation: Conversation
}

export default function Composer({ conversation }: Props) {
  const send = useChatStore((s) => s.send)
  const abort = useChatStore((s) => s.abort)
  const update = useChatStore((s) => s.update)
  const create = useChatStore((s) => s.create)
  const streaming = useChatStore((s) => conversation.id in s.streaming)
  const usage = useChatStore((s) => s.usage[conversation.id])
  const collections = useLibraryStore((s) => s.collections)
  const chatDefaultTier =
    useModelsStore((s) => s.overview?.defaults.chat) ?? FEATURE_DEFAULTS.chat

  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<AttachmentInput[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [mcpOpen, setMcpOpen] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [skills, setSkills] = useState<SkillMeta[]>([])
  const [slashHighlight, setSlashHighlight] = useState(0)
  const [samplingOpen, setSamplingOpen] = useState(false)
  // In-flight pasted/dropped image saves; submit blocks on these (see submit()).
  const [pendingPastes, setPendingPastes] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const samplingRef = useRef<HTMLDivElement>(null)
  // Sampling popover: Escape / click-outside dismiss like every other overlay.
  useDismissable(samplingOpen, () => setSamplingOpen(false), { outsideRef: samplingRef })

  useEffect(() => {
    // Chat only sees opted-in skills — the badge must match what the model
    // actually gets, not advertise the agent-only packs.
    void call('skills.list')
      .then((r) => setSkills(r.skills.filter((s) => s.chatEnabled)))
      .catch(() => {})
  }, [])

  useAutosizeTextarea(textareaRef, text, MAX_TEXTAREA_PX)

  const addFiles = (files: Iterable<File>): void => {
    for (const file of files) {
      const path = pathForFile(file)
      if (!path) {
        // No filesystem path (drag-dropped bitmap): persist the bytes via main
        // like the paste handler, instead of dropping it with an error.
        if (file.type.startsWith('image/')) void savePastedImage(file)
        else
          pushToast(
            'error',
            `Cannot resolve a filesystem path for "${file.name}" — the preload needs a getPathForFile bridge.`
          )
        continue
      }
      setAttachments((prev) =>
        prev.some((a) => a.path === path) ? prev : [...prev, { path, kind: kindForPath(path) }]
      )
    }
  }

  // Pasted screenshots have no filesystem path — persist the bytes via main,
  // then attach the returned temp path through the normal image pipeline.
  const savePastedImage = async (file: File): Promise<void> => {
    setPendingPastes((n) => n + 1)
    try {
      const dataBase64 = toBase64(await file.arrayBuffer())
      const { path } = await call('chat.savePastedFile', {
        name: file.name || 'pasted.png',
        mime: file.type,
        dataBase64
      })
      setAttachments((prev) =>
        prev.some((a) => a.path === path) ? prev : [...prev, { path, kind: 'image' }]
      )
    } catch (err) {
      toastError(err)
    } finally {
      setPendingPastes((n) => n - 1)
    }
  }

  const submit = (): void => {
    const trimmed = text.trim()
    // Block while a pasted/dropped image is still being persisted — submit
    // captures and clears `attachments` synchronously, so an in-flight image
    // would miss THIS message and be staged onto the next one.
    if (streaming || pendingPastes > 0 || (!trimmed && attachments.length === 0)) return
    const toSend = attachments
    setText('')
    setAttachments([])
    void send(conversation.id, trimmed, toSend.length > 0 ? toSend : undefined).catch((err) => {
      // A rejected send persisted nothing — put the draft back so the user
      // doesn't retype it, unless newer input has been entered meanwhile.
      setText((cur) => cur || trimmed)
      setAttachments((cur) => (cur.length ? cur : toSend))
      toastError(err)
    })
  }

  // Slash quick-actions: `/` at composer start opens a filterable menu that
  // EXECUTES (never sends a message). Not a saved-prompt library.
  const slashFilter = /^\/(\w*)$/.exec(text)?.[1]?.toLowerCase()
  const slashCommands = (
    slashFilter === undefined
      ? []
      : [
          {
            name: 'web',
            label: `Web search — turn ${conversation.webEnabled ? 'off' : 'on'}`,
            run: () => {
              void update(conversation.id, { webEnabled: !conversation.webEnabled }).catch(toastError)
              setText('')
            }
          },
          {
            name: 'clear',
            label: 'New conversation',
            run: () => {
              void create().catch(toastError)
              setText('')
            }
          },
          {
            name: 'search',
            label: 'Search conversations',
            run: () => {
              usePaletteStore.getState().setOpen(true)
              setText('')
            }
          },
          {
            name: 'think',
            label: 'Prefix: think step by step',
            run: () => setText('Think carefully, step by step. ')
          }
        ]
  ).filter((c) => c.name.startsWith(slashFilter ?? ''))
  const showSlash = slashCommands.length > 0

  // Per-conversation sampling override; clearing all three reverts to model defaults.
  const setSamplingField = (field: 'temperature' | 'topP' | 'topK', raw: string): void => {
    const v = raw.trim() === '' ? null : Number(raw)
    if (v !== null && !Number.isFinite(v)) return
    const s = conversation.sampling
    const next = {
      temperature: field === 'temperature' ? v : (s?.temperature ?? null),
      topP: field === 'topP' ? v : (s?.topP ?? null),
      topK: field === 'topK' ? v : (s?.topK ?? null)
    }
    const allNull = next.temperature === null && next.topP === null && next.topK === null
    void update(conversation.id, { sampling: allNull ? null : next }).catch(toastError)
  }

  return (
    <div className="shrink-0">
      <div className="mx-auto w-full max-w-3xl px-6 pb-4">
        <div
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            addFiles(Array.from(e.dataTransfer.files))
          }}
          className={`relative rounded-xl border bg-zinc-900/80 ${
            dragOver ? 'border-emerald-500/60 ring-1 ring-emerald-500/30' : 'border-zinc-800'
          }`}
        >
          {showSlash && (
            <div className="absolute bottom-full left-2 z-20 mb-1 min-w-60 rounded-lg border border-zinc-700 bg-zinc-900 py-1 shadow-xl">
              {slashCommands.map((c, i) => (
                <button
                  key={c.name}
                  onMouseEnter={() => setSlashHighlight(i)}
                  onClick={() => c.run()}
                  className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] ${
                    i === slashHighlight ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-300'
                  }`}
                >
                  <span className="font-mono text-zinc-500">/{c.name}</span>
                  <span className="text-zinc-400">{c.label}</span>
                </button>
              ))}
            </div>
          )}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
              {attachments.map((a) => (
                <span
                  key={a.path}
                  title={a.path}
                  className="flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-950/60 px-2 py-1 text-[11px] text-zinc-300"
                >
                  {a.kind === 'image' ? (
                    <ImageIcon size={11} className="text-zinc-500" />
                  ) : (
                    <FileText size={11} className="text-zinc-500" />
                  )}
                  <span className="max-w-44 truncate">{basename(a.path)}</span>
                  <button
                    onClick={() =>
                      setAttachments((prev) => prev.filter((x) => x.path !== a.path))
                    }
                    className="rounded p-px text-zinc-600 hover:text-zinc-200"
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setSlashHighlight(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && samplingOpen) {
                e.preventDefault()
                setSamplingOpen(false)
                return
              }
              if (showSlash) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setSlashHighlight((h) => (h + 1) % slashCommands.length)
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setSlashHighlight((h) => (h - 1 + slashCommands.length) % slashCommands.length)
                  return
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault()
                  slashCommands[Math.min(slashHighlight, slashCommands.length - 1)]?.run()
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setText('')
                  return
                }
              }
              if (e.key === 'Escape' && streaming) {
                e.preventDefault()
                void abort(conversation.id).catch(toastError)
                return
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                submit()
              }
            }}
            onPaste={(e) => {
              const all = Array.from(e.clipboardData.files)
              if (all.length === 0) return // plain text → default paste
              e.preventDefault()
              const withPath = all.filter((f) => pathForFile(f))
              if (withPath.length > 0) addFiles(withPath)
              // Bitmaps (screenshots) have no path — persist + attach via main.
              const bitmaps = all.filter((f) => !pathForFile(f) && f.type.startsWith('image/'))
              for (const f of bitmaps) void savePastedImage(f)
              // Anything we can neither path-resolve nor read as an image is dropped —
              // say so rather than silently swallow it (default paste was prevented).
              const dropped = all.length - withPath.length - bitmaps.length
              if (dropped > 0)
                pushToast(
                  'warn',
                  `Couldn't attach ${dropped} pasted item${dropped === 1 ? '' : 's'} (unsupported type).`
                )
            }}
            rows={1}
            placeholder="Message… (Enter to send, Shift+Enter for newline)"
            spellCheck={false}
            className="block max-h-44 w-full resize-none bg-transparent px-3.5 py-3 text-[13px] leading-relaxed text-zinc-200 outline-none placeholder:text-zinc-600"
          />

          <div className="flex items-center gap-1.5 px-2.5 pb-2.5">
            <input
              ref={fileRef}
              type="file"
              multiple
              accept={FILE_ACCEPT}
              className="hidden"
              onChange={(e) => {
                if (e.target.files) addFiles(Array.from(e.target.files))
                e.target.value = ''
              }}
            />
            {/* Order per the PDF: attach, web, MCP adjacent — then tier, then RAG. */}
            <button
              onClick={() => fileRef.current?.click()}
              title="Attach images or documents"
              className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
            >
              <Paperclip size={14} />
            </button>

            <button
              onClick={() =>
                void update(conversation.id, { webEnabled: !conversation.webEnabled }).catch(
                  toastError
                )
              }
              title={conversation.webEnabled ? 'Web search: on' : 'Web search: off'}
              className={`rounded-md border p-1.5 ${
                conversation.webEnabled
                  ? 'border-sky-500/40 bg-sky-500/10 text-sky-400'
                  : 'border-transparent text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200'
              }`}
            >
              <Globe size={14} />
            </button>

            <button
              onClick={() => setMcpOpen(true)}
              title="MCP servers"
              className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
            >
              <Settings2 size={14} />
            </button>

            <div ref={samplingRef} className="relative">
              <button
                onClick={() => setSamplingOpen((o) => !o)}
                title="Sampling"
                aria-haspopup="dialog"
                aria-expanded={samplingOpen}
                className={`rounded-md p-1.5 ${
                  conversation.sampling
                    ? 'text-amber-400'
                    : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200'
                }`}
              >
                <Sliders size={14} />
              </button>
              {samplingOpen && (
                <div className="absolute bottom-full left-0 z-20 mb-1 w-48 rounded-lg border border-zinc-700 bg-zinc-900 p-2.5 shadow-xl">
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-[11px] font-medium text-zinc-300">Sampling</span>
                    {conversation.sampling && (
                      <button
                        onClick={() => {
                          void update(conversation.id, { sampling: null }).catch(toastError)
                          setSamplingOpen(false)
                        }}
                        className="text-[10px] text-zinc-500 hover:text-zinc-300"
                      >
                        Reset
                      </button>
                    )}
                  </div>
                  {(
                    [
                      ['temperature', 'Temp'],
                      ['topP', 'Top-P'],
                      ['topK', 'Top-K']
                    ] as const
                  ).map(([field, label]) => (
                    <label
                      key={field}
                      className="mb-1 flex items-center justify-between gap-2 text-[11px] text-zinc-500"
                    >
                      {label}
                      <input
                        defaultValue={conversation.sampling?.[field] ?? ''}
                        placeholder="auto"
                        inputMode="decimal"
                        onBlur={(e) => setSamplingField(field, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') e.currentTarget.blur()
                        }}
                        className="w-16 rounded border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 text-right text-[11px] text-zinc-200 outline-none focus:border-zinc-600"
                      />
                    </label>
                  ))}
                </div>
              )}
            </div>

            <select
              value={conversation.family ?? ''}
              onChange={(e) =>
                void update(conversation.id, {
                  // '' = follow the global active family live.
                  family: e.target.value === '' ? null : (e.target.value as Family)
                }).catch(toastError)
              }
              title="Model family"
              className={selectClass}
            >
              <option value="">Default</option>
              {FAMILIES.map((family) => (
                <option key={family} value={family}>
                  {FAMILY_LABELS[family]}
                </option>
              ))}
            </select>

            <select
              value={conversation.tierPinned ? conversation.defaultTier : ''}
              onChange={(e) =>
                void update(conversation.id, {
                  // '' = un-pin: follow the chat feature default live.
                  defaultTier: e.target.value === '' ? null : (e.target.value as Tier)
                }).catch(toastError)
              }
              title="Model tier"
              className={selectClass}
            >
              <option value="">Default ({TIER_LABELS[chatDefaultTier]})</option>
              {TIER_ORDER.map((tier) => (
                <option key={tier} value={tier}>
                  {TIER_LABELS[tier]}
                </option>
              ))}
            </select>

            <select
              value={conversation.collectionId ?? ''}
              onChange={(e) => {
                // The select is controlled, so picking "Manage…" snaps back on re-render.
                if (e.target.value === MANAGE_SENTINEL) {
                  setLibraryOpen(true)
                  return
                }
                void update(conversation.id, { collectionId: e.target.value || null }).catch(
                  toastError
                )
              }}
              title="RAG collection"
              className={selectClass}
            >
              <option value="">No collection</option>
              {collections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.docCount})
                </option>
              ))}
              <option value={MANAGE_SENTINEL}>Manage library…</option>
            </select>

            {skills.length > 0 && (
              <span
                title={skills.map((s) => `${s.name} — ${s.description}`).join('\n')}
                className="flex items-center gap-1 text-[11px] text-zinc-600"
              >
                <Sparkles size={12} />
                {skills.length}
              </span>
            )}

            <div className="ml-auto flex items-center gap-2">
              {usage && <ContextDonut used={usage.used} contextLength={usage.contextLength} />}
              {streaming ? (
                <button
                  onClick={() => void abort(conversation.id).catch(toastError)}
                  title="Stop generating"
                  className="rounded-lg bg-red-600/90 p-2 text-white hover:bg-red-500"
                >
                  <Square size={13} />
                </button>
              ) : (
                <button
                  onClick={submit}
                  disabled={pendingPastes > 0 || (!text.trim() && attachments.length === 0)}
                  title="Send"
                  className="rounded-lg bg-emerald-600 p-2 text-white enabled:hover:bg-emerald-500 disabled:opacity-40"
                >
                  <SendHorizontal size={13} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      <McpDialog open={mcpOpen} onClose={() => setMcpOpen(false)} />
      <LibraryDialog
        open={libraryOpen}
        onClose={() => setLibraryOpen(false)}
        initialCollectionId={conversation.collectionId}
      />
    </div>
  )
}
