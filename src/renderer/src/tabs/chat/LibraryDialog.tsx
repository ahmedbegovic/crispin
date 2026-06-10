import { useEffect, useRef, useState } from 'react'
import { Loader2, Plus, Trash2, Upload } from 'lucide-react'
import type { LibraryDocStatus } from '@shared/types'
import { useLibraryStore } from '@/stores/library'
import { pushToast, toastError } from '@/stores/toasts'
import { relativeTime } from '@/lib/format'
import ConfirmDialog from '@/components/ConfirmDialog'
import Modal from './Modal'
import { basename, pathForFile } from './attachments'

const inputClass =
  'rounded-md border border-zinc-800 bg-zinc-950/60 px-2 py-1 text-[12px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-zinc-600'

function StatusChip({ status }: { status: LibraryDocStatus }) {
  switch (status) {
    case 'pending':
      return <span className="w-16 shrink-0 text-[11px] text-zinc-500">queued</span>
    case 'ingesting':
      return (
        <span className="flex w-16 shrink-0 items-center gap-1 text-[11px] text-amber-400">
          <Loader2 size={11} className="animate-spin" />
          ingesting
        </span>
      )
    case 'ready':
      return (
        <span className="flex w-16 shrink-0 items-center gap-1.5 text-[11px] text-emerald-400">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
          ready
        </span>
      )
    case 'failed':
      return <span className="w-16 shrink-0 text-[11px] text-red-400">failed</span>
  }
}

interface Props {
  open: boolean
  onClose: () => void
  initialCollectionId?: string | null
}

export default function LibraryDialog({ open, onClose, initialCollectionId }: Props) {
  const collections = useLibraryStore((s) => s.collections)
  const docsByCollection = useLibraryStore((s) => s.docsByCollection)
  const loadDocs = useLibraryStore((s) => s.loadDocs)
  const createCollection = useLibraryStore((s) => s.createCollection)
  const deleteCollection = useLibraryStore((s) => s.deleteCollection)
  const ingest = useLibraryStore((s) => s.ingest)
  const deleteDoc = useLibraryStore((s) => s.deleteDoc)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [source, setSource] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) setSelectedId(initialCollectionId ?? collections[0]?.id ?? null)
    // Re-resolve only when the dialog opens, not as collections refresh underneath.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (open && selectedId) void loadDocs(selectedId).catch(toastError)
  }, [open, selectedId, loadDocs])

  const selected = collections.find((c) => c.id === selectedId)
  const docs = selectedId ? (docsByCollection[selectedId] ?? []) : []

  const addCollection = (): void => {
    const name = newName.trim()
    if (!name) return
    setNewName('')
    void createCollection(name)
      .then((collection) => setSelectedId(collection.id))
      .catch(toastError)
  }

  const addSource = (): void => {
    const value = source.trim()
    if (!value || !selectedId) return
    setSource('')
    const input = /^https?:\/\//i.test(value) ? { url: value } : { path: value }
    void ingest(selectedId, input).catch(toastError)
  }

  const addFiles = (files: Iterable<File>): void => {
    if (!selectedId) return
    for (const file of files) {
      const path = pathForFile(file)
      if (!path) {
        pushToast(
          'error',
          `Cannot resolve a filesystem path for "${file.name}" — paste the absolute path instead.`
        )
        continue
      }
      void ingest(selectedId, { path }).catch(toastError)
    }
  }

  return (
    <Modal open={open} title="Library" wide onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <select
            value={selectedId ?? ''}
            onChange={(e) => setSelectedId(e.target.value || null)}
            className={`${inputClass} min-w-40`}
          >
            {collections.length === 0 && <option value="">No collections</option>}
            {collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.docCount})
              </option>
            ))}
          </select>
          {selected && (
            <button
              onClick={() => setConfirmDelete(true)}
              title="Delete collection"
              className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
            >
              <Trash2 size={13} />
            </button>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addCollection()
              }}
              placeholder="New collection…"
              spellCheck={false}
              className={`${inputClass} w-40`}
            />
            <button
              onClick={addCollection}
              disabled={!newName.trim()}
              title="Create collection"
              className="rounded-md border border-zinc-700 p-1 text-zinc-400 enabled:hover:border-zinc-500 enabled:hover:text-zinc-200 disabled:opacity-40"
            >
              <Plus size={13} />
            </button>
          </div>
        </div>

        {selected ? (
          <>
            <div className="flex items-center gap-1.5">
              <input
                value={source}
                onChange={(e) => setSource(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addSource()
                }}
                placeholder="https://… or /absolute/path/to/file.pdf"
                spellCheck={false}
                className={`${inputClass} flex-1`}
              />
              <input
                ref={fileRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) addFiles(Array.from(e.target.files))
                  e.target.value = ''
                }}
              />
              <button
                onClick={() => fileRef.current?.click()}
                title="Browse files"
                className="rounded-md border border-zinc-700 p-1 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
              >
                <Upload size={13} />
              </button>
              <button
                onClick={addSource}
                disabled={!source.trim()}
                className="rounded-md bg-emerald-600 px-2.5 py-1 text-[12px] font-medium text-white enabled:hover:bg-emerald-500 disabled:opacity-40"
              >
                Ingest
              </button>
            </div>

            {docs.length === 0 ? (
              <p className="py-2 text-[12px] text-zinc-600">
                No documents yet. Ingest a file or URL to make it searchable in chat.
              </p>
            ) : (
              <div className="divide-y divide-zinc-800/70 rounded-lg border border-zinc-800 bg-zinc-900/30">
                {docs.map((doc) => (
                  <div key={doc.id} className="flex items-center gap-2.5 px-3 py-2">
                    <StatusChip status={doc.status} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12px] text-zinc-200" title={doc.source}>
                        {doc.title ?? basename(doc.source)}
                      </div>
                      <div className="truncate text-[11px] text-zinc-600">
                        {doc.kind} · {doc.chunkCount} chunks · {relativeTime(doc.createdAt)}
                      </div>
                      {doc.error && (
                        <div className="select-text text-[11px] text-red-400">{doc.error}</div>
                      )}
                    </div>
                    <button
                      onClick={() =>
                        void deleteDoc(doc.collectionId, doc.id).catch(toastError)
                      }
                      title="Delete document"
                      className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <p className="py-2 text-[12px] text-zinc-600">
            Create a collection to ingest documents for RAG.
          </p>
        )}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete collection"
        body={`Delete "${selected?.name ?? ''}" and its ${selected?.docCount ?? 0} document(s)? Conversations using it fall back to no collection.`}
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          if (selectedId) {
            void deleteCollection(selectedId)
              .then(() => setSelectedId(useLibraryStore.getState().collections[0]?.id ?? null))
              .catch(toastError)
          }
          setConfirmDelete(false)
        }}
        onCancel={() => setConfirmDelete(false)}
      />
    </Modal>
  )
}
