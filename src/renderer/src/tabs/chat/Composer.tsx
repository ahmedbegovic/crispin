import { useEffect, useRef, useState } from 'react'
import {
  FileText,
  Globe,
  Image as ImageIcon,
  Paperclip,
  SendHorizontal,
  Settings2,
  Sparkles,
  Square,
  X
} from 'lucide-react'
import { TIER_ORDER } from '@shared/model-tiers'
import type { AttachmentInput, Conversation, SkillMeta, Tier } from '@shared/types'
import { call } from '@/lib/ipc'
import { useChatStore } from '@/stores/chat'
import { useLibraryStore } from '@/stores/library'
import { pushToast, toastError } from '@/stores/toasts'
import { basename, kindForPath, pathForFile } from './attachments'
import McpDialog from './McpDialog'
import LibraryDialog from './LibraryDialog'
import ContextDonut from './ContextDonut'

const TIER_LABELS: Record<Tier, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  extraHigh: 'Extra high',
  ultra: 'Ultra'
}

const FILE_ACCEPT =
  'image/png,image/jpeg,image/webp,image/gif,.pdf,.docx,.pptx,.xlsx,.md,.txt,.html,.csv,.epub'

const MAX_TEXTAREA_PX = 180

const MANAGE_SENTINEL = '__manage__'

const selectClass =
  'rounded-md border border-zinc-800 bg-zinc-900 px-1.5 py-1 text-[11px] text-zinc-400 outline-none hover:text-zinc-200 focus:border-zinc-600'

interface Props {
  conversation: Conversation
}

export default function Composer({ conversation }: Props) {
  const send = useChatStore((s) => s.send)
  const abort = useChatStore((s) => s.abort)
  const update = useChatStore((s) => s.update)
  const streaming = useChatStore((s) => conversation.id in s.streaming)
  const usage = useChatStore((s) => s.usage[conversation.id])
  const collections = useLibraryStore((s) => s.collections)

  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<AttachmentInput[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [mcpOpen, setMcpOpen] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [skills, setSkills] = useState<SkillMeta[]>([])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void call('skills.list')
      .then((r) => setSkills(r.skills))
      .catch(() => {})
  }, [])

  // Autosize after every text commit (covers programmatic clears on send).
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_PX)}px`
  }, [text])

  const addFiles = (files: Iterable<File>): void => {
    for (const file of files) {
      const path = pathForFile(file)
      if (!path) {
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

  const submit = (): void => {
    const trimmed = text.trim()
    if (streaming || (!trimmed && attachments.length === 0)) return
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
          className={`rounded-xl border bg-zinc-900/80 ${
            dragOver ? 'border-emerald-500/60 ring-1 ring-emerald-500/30' : 'border-zinc-800'
          }`}
        >
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
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                submit()
              }
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
            <button
              onClick={() => fileRef.current?.click()}
              title="Attach images or documents"
              className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
            >
              <Paperclip size={14} />
            </button>

            <select
              value={conversation.defaultTier}
              onChange={(e) =>
                void update(conversation.id, { defaultTier: e.target.value as Tier }).catch(
                  toastError
                )
              }
              title="Model tier"
              className={selectClass}
            >
              {TIER_ORDER.map((tier) => (
                <option key={tier} value={tier}>
                  {TIER_LABELS[tier]}
                </option>
              ))}
            </select>

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

            <button
              onClick={() => setMcpOpen(true)}
              title="MCP servers"
              className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
            >
              <Settings2 size={14} />
            </button>

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
                  disabled={!text.trim() && attachments.length === 0}
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
