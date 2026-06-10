import { useEffect, useRef, useState } from 'react'
import * as monaco from 'monaco-editor'
import Editor, { type OnMount } from '@monaco-editor/react'
import { FileCode2, TriangleAlert, X } from 'lucide-react'
import { useCodeStore, type OpenFile } from '@/stores/code'
import { toastError } from '@/stores/toasts'
import ConfirmDialog from '@/components/ConfirmDialog'

// Explicit map for the common cases; unmapped extensions fall back to monaco's
// own filename-based detection (language === undefined).
const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'xml',
  md: 'markdown',
  py: 'python',
  rs: 'rust',
  go: 'go',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  java: 'java',
  rb: 'ruby',
  swift: 'swift',
  kt: 'kotlin',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  sql: 'sql',
  txt: 'plaintext'
}

function baseName(path: string): string {
  return path.split('/').pop() ?? path
}

function languageFor(path: string): string | undefined {
  const name = baseName(path)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return undefined
  return LANGUAGE_BY_EXT[name.slice(dot + 1).toLowerCase()]
}

export default function EditorPane() {
  const root = useCodeStore((s) => s.root)
  const openFiles = useCodeStore((s) => s.openFiles)
  const activePath = useCodeStore((s) => s.activePath)
  const setActive = useCodeStore((s) => s.setActive)
  const edit = useCodeStore((s) => s.edit)
  const save = useCodeStore((s) => s.save)
  const reloadFromDisk = useCodeStore((s) => s.reloadFromDisk)
  const closeFile = useCodeStore((s) => s.closeFile)
  const [closeTarget, setCloseTarget] = useState<OpenFile | null>(null)

  const activeFile = openFiles.find((f) => f.path === activePath)

  // Dispose monaco models of closed files (the Editor never disposes them
  // itself), keyed by root-namespaced URIs so relative paths from different
  // workspaces never collide. Child (Editor) effects run first, so the
  // editor has already swapped models before a stale one is disposed.
  useEffect(() => {
    const keep = new Set(openFiles.map((f) => monaco.Uri.parse(`${root}/${f.path}`).toString()))
    for (const model of monaco.editor.getModels()) {
      if (!keep.has(model.uri.toString())) model.dispose()
    }
  }, [openFiles, root])

  // The monaco command outlives renders — it reads the live active path here.
  const saveActiveRef = useRef<() => void>(() => {})
  saveActiveRef.current = () => {
    const path = useCodeStore.getState().activePath
    if (path) void save(path).catch(toastError)
  }

  const handleMount: OnMount = (editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveActiveRef.current())
  }

  const requestClose = (file: OpenFile): void => {
    if (file.dirty) setCloseTarget(file)
    else closeFile(file.path)
  }

  return (
    <div
      className="flex h-full min-w-0 flex-col"
      onKeyDown={(e) => {
        // Fallback for focus outside monaco (tab strip etc.); the store's
        // in-flight guard absorbs the double fire when monaco also handles it.
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
          e.preventDefault()
          saveActiveRef.current()
        }
      }}
    >
      {openFiles.length > 0 && (
        <div className="no-drag flex shrink-0 items-stretch overflow-x-auto border-b border-zinc-800/80 bg-zinc-950/30">
          {openFiles.map((file) => {
            const active = file.path === activePath
            return (
              <div
                key={file.path}
                title={file.path}
                onClick={() => setActive(file.path)}
                className={`flex shrink-0 cursor-pointer items-center gap-1.5 border-r border-zinc-800/60 py-1.5 pl-3 pr-1.5 text-[12px] ${
                  active ? 'bg-[#1e1e1e] text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                <span className="max-w-44 truncate">{baseName(file.path)}</span>
                {file.dirty && (
                  <span
                    title="Unsaved changes"
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400"
                  />
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    requestClose(file)
                  }}
                  title="Close"
                  className="rounded p-0.5 text-zinc-600 hover:bg-zinc-700 hover:text-zinc-200"
                >
                  <X size={12} />
                </button>
              </div>
            )
          })}
        </div>
      )}

      {activeFile?.conflict && (
        <div className="no-drag flex shrink-0 items-center gap-2 border-b border-amber-900/40 bg-amber-950/30 px-3 py-1.5 text-[12px] text-amber-300">
          <TriangleAlert size={13} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {baseName(activeFile.path)} changed on disk since it was loaded.
          </span>
          <button
            onClick={() => void reloadFromDisk(activeFile.path).catch(toastError)}
            className="rounded-md px-2 py-0.5 font-medium text-amber-200 hover:bg-amber-900/40"
          >
            Reload
          </button>
          <button
            onClick={() => void save(activeFile.path, { overwrite: true }).catch(toastError)}
            className="rounded-md px-2 py-0.5 font-medium text-amber-200 hover:bg-amber-900/40"
          >
            Overwrite
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1">
        {activeFile ? (
          <Editor
            path={`${root}/${activeFile.path}`}
            value={activeFile.content}
            language={languageFor(activeFile.path)}
            theme="vs-dark"
            onMount={handleMount}
            onChange={(value) => {
              if (value !== undefined) edit(activeFile.path, value)
            }}
            options={{
              automaticLayout: true,
              fontSize: 12.5,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              padding: { top: 8 }
            }}
            loading={<span className="text-[12px] text-zinc-600">Loading editor…</span>}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2">
            <FileCode2 size={26} strokeWidth={1.5} className="text-zinc-700" />
            <p className="text-[12px] text-zinc-600">Open a file from the tree to start editing.</p>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={closeTarget !== null}
        title="Discard changes"
        body={`"${closeTarget ? baseName(closeTarget.path) : ''}" has unsaved changes. Close it and discard them?`}
        confirmLabel="Discard"
        danger
        onConfirm={() => {
          if (closeTarget) closeFile(closeTarget.path)
          setCloseTarget(null)
        }}
        onCancel={() => setCloseTarget(null)}
      />
    </div>
  )
}
