import { useEffect, useState, type ReactNode } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import type { AppSettings, MethodOutput } from '@shared/ipc'
import type { Feature } from '@shared/types'
import { CORE_MODULES, OPTIONAL_MODULES } from '@shared/modules'
import { call, onEvent } from '@/lib/ipc'
import { MODULE_ICONS } from '@/lib/module-icons'
import { useSettingsStore } from '@/stores/settings'
import { useSystemStore } from '@/stores/system'
import { pushToast, toastError } from '@/stores/toasts'
import { formatBytes } from '@/lib/format'

const INSTRUCTION_MODULES: Array<{ id: Feature; label: string }> = [
  { id: 'chat', label: 'Chat' },
  { id: 'agent', label: 'Agent' },
  { id: 'code', label: 'Code' },
  { id: 'research', label: 'Research' },
  { id: 'news', label: 'News' }
]

export function Section({
  title,
  hint,
  children
}: {
  title: string
  hint?: string
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-[13px] font-semibold text-zinc-200">{title}</h2>
        {hint && <p className="mt-0.5 text-[11.5px] leading-relaxed text-zinc-600">{hint}</p>}
      </div>
      {children}
    </section>
  )
}

const inputClass =
  'w-full rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-[12.5px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-zinc-600'

/** Text input that commits to settings on blur (single-user app, no save button). */
function CommitInput({
  value,
  placeholder,
  multiline = false,
  rows = 3,
  onCommit
}: {
  value: string
  placeholder?: string
  multiline?: boolean
  rows?: number
  onCommit: (next: string) => void
}) {
  const [draft, setDraft] = useState(value)
  // External updates (settings.changed from main) refresh an unfocused draft.
  useEffect(() => setDraft(value), [value])

  const commit = (): void => {
    if (draft !== value) onCommit(draft)
  }

  if (multiline) {
    return (
      <textarea
        value={draft}
        rows={rows}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        className={`${inputClass} resize-y leading-relaxed`}
      />
    )
  }
  return (
    <input
      value={draft}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
      className={inputClass}
    />
  )
}

function ProfileSection({
  settings,
  update
}: {
  settings: AppSettings
  update: (patch: Partial<AppSettings>) => void
}) {
  return (
    <Section
      title="Profile"
      hint="Both names reach every model: chat, agent, research and news prompts."
    >
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1.5 text-[11px] font-medium text-zinc-500">
          Your name
          <CommitInput
            value={settings.profile.userName}
            placeholder="How the assistant addresses you"
            onCommit={(userName) => update({ profile: { ...settings.profile, userName } })}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-[11px] font-medium text-zinc-500">
          Assistant name
          <CommitInput
            value={settings.profile.assistantName}
            placeholder="Crispin"
            onCommit={(assistantName) => update({ profile: { ...settings.profile, assistantName } })}
          />
        </label>
      </div>
    </Section>
  )
}

function InstructionsSection({
  settings,
  update
}: {
  settings: AppSettings
  update: (patch: Partial<AppSettings>) => void
}) {
  const { instructions } = settings
  return (
    <Section
      title="Instructions"
      hint="Standing guidance prepended to prompts — global first, then the module's own."
    >
      <label className="flex flex-col gap-1.5 text-[11px] font-medium text-zinc-500">
        Global
        <CommitInput
          multiline
          value={instructions.global}
          placeholder="e.g. Always answer in short paragraphs. Prefer metric units."
          onCommit={(global) => update({ instructions: { ...instructions, global } })}
        />
      </label>
      <div className="grid grid-cols-2 gap-3">
        {INSTRUCTION_MODULES.map(({ id, label }) => (
          <label key={id} className="flex flex-col gap-1.5 text-[11px] font-medium text-zinc-500">
            {label}
            <CommitInput
              multiline
              rows={2}
              value={instructions.perModule[id] ?? ''}
              onCommit={(text) =>
                update({
                  instructions: {
                    ...instructions,
                    perModule: { ...instructions.perModule, [id]: text }
                  }
                })
              }
            />
          </label>
        ))}
      </div>
    </Section>
  )
}

function ModulesSection({
  settings,
  update
}: {
  settings: AppSettings
  update: (patch: Partial<AppSettings>) => void
}) {
  return (
    <Section
      title="Modules"
      hint="Core modules are always on. Optional modules toggle on click — placeholders arrive in Version 3."
    >
      {/* Core modules: a static row, no toggles. */}
      <div className="flex flex-wrap gap-2">
        {CORE_MODULES.map((m) => {
          const Icon = MODULE_ICONS[m.id]
          return (
            <div
              key={m.id}
              className="flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5 text-[11.5px] text-zinc-400"
            >
              <Icon size={13} />
              {m.label}
            </div>
          )
        })}
      </div>
      <div className="border-t border-zinc-800/80" />
      <div className="grid grid-cols-3 gap-2">
        {OPTIONAL_MODULES.map((m) => {
          const Icon = MODULE_ICONS[m.id]
          const enabled = settings.modulesEnabled[m.id] ?? m.defaultEnabled
          return (
            <button
              key={m.id}
              onClick={() =>
                update({ modulesEnabled: { ...settings.modulesEnabled, [m.id]: !enabled } })
              }
              aria-pressed={enabled}
              className={`flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors ${
                enabled
                  ? 'border-emerald-600/60 bg-emerald-600/10'
                  : 'border-zinc-800 bg-zinc-900/40 hover:border-zinc-700'
              }`}
            >
              <span
                className={`flex items-center gap-1.5 text-[12px] font-medium ${
                  enabled ? 'text-emerald-300' : 'text-zinc-300'
                }`}
              >
                <Icon size={13} />
                {m.label}
                {m.placeholder && (
                  <span className="rounded-full border border-zinc-700 px-1.5 text-[9.5px] font-normal text-zinc-500">
                    v3
                  </span>
                )}
              </span>
              <span className="text-[10.5px] leading-snug text-zinc-600">{m.description}</span>
            </button>
          )
        })}
      </div>
    </Section>
  )
}

function ModelsSection({
  settings,
  update
}: {
  settings: AppSettings
  update: (patch: Partial<AppSettings>) => void
}) {
  const minutes = Math.round(settings.idleUnloadSeconds / 60)
  const [draft, setDraft] = useState(String(minutes))
  useEffect(() => setDraft(String(minutes)), [minutes])

  const commit = (): void => {
    const next = Math.max(0, Math.round(Number(draft)))
    if (!Number.isFinite(next)) {
      setDraft(String(minutes))
      return
    }
    if (next !== minutes) update({ idleUnloadSeconds: next * 60 })
  }

  return (
    <Section
      title="Models"
      hint="Loaded models are unloaded after this long without activity in Crispin. 0 disables."
    >
      <label className="flex items-center gap-2 text-[12px] text-zinc-400">
        Unload after
        <input
          value={draft}
          inputMode="numeric"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
          className="w-16 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-right text-[12.5px] tabular-nums text-zinc-200 outline-none focus:border-zinc-600"
        />
        idle minutes
      </label>
    </Section>
  )
}

function NewsSection({
  settings,
  update
}: {
  settings: AppSettings
  update: (patch: Partial<AppSettings>) => void
}) {
  return (
    <Section
      title="News"
      hint="Topic filter applied when feeds are fetched — items matching none are skipped. Empty keeps everything."
    >
      <label className="flex flex-col gap-1.5 text-[11px] font-medium text-zinc-500">
        Topics (comma-separated)
        <CommitInput
          value={settings.newsTopics.join(', ')}
          placeholder="e.g. AI, formula 1, macOS"
          onCommit={(text) =>
            update({
              newsTopics: text
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean)
            })
          }
        />
      </label>
    </Section>
  )
}

type RuntimesStatus = MethodOutput<'runtimes.status'>
type RuntimesLatest = MethodOutput<'runtimes.checkLatest'>
type RuntimeComponent = 'engine' | 'tools' | 'opencode'

function RuntimesSection() {
  const [status, setStatus] = useState<RuntimesStatus | null>(null)
  const [latest, setLatest] = useState<RuntimesLatest | null>(null)
  const [checking, setChecking] = useState(false)
  const [busy, setBusy] = useState<RuntimeComponent | null>(null)

  const refresh = (): void => {
    void call('runtimes.status')
      .then(setStatus)
      .catch(() => {})
  }

  useEffect(() => {
    refresh()
    return onEvent('runtimes.changed', refresh)
  }, [])

  const checkLatest = (): void => {
    setChecking(true)
    void call('runtimes.checkLatest')
      .then(setLatest)
      .catch(toastError)
      .finally(() => setChecking(false))
  }

  const run = (component: RuntimeComponent, action: 'update' | 'reset', version?: string): void => {
    setBusy(component)
    const op =
      action === 'update'
        ? call('runtimes.update', { component, version })
        : call('runtimes.reset', { component })
    void op
      .then(() => {
        if (action === 'reset') pushToast('info', `${component} reset to the bundled version.`)
      })
      .catch(toastError)
      .finally(() => setBusy(null))
  }

  const row = (opts: {
    component: RuntimeComponent
    label: string
    current: string
    latestVersion: string | null
    pinned: boolean
    caption: string
  }): ReactNode => {
    const updatable =
      opts.latestVersion !== null && !opts.current.includes(opts.latestVersion)
    return (
      <div
        key={opts.component}
        className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2"
      >
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-medium text-zinc-200">
            {opts.label}
            {opts.pinned && (
              <span className="ml-1.5 rounded-full border border-amber-500/40 px-1.5 text-[9.5px] text-amber-400">
                updated
              </span>
            )}
          </p>
          <p className="truncate text-[11px] text-zinc-500">
            {opts.current}
            {opts.latestVersion !== null && ` → latest ${opts.latestVersion}`}
          </p>
          <p className="text-[10px] text-zinc-700">{opts.caption}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {busy === opts.component ? (
            <Loader2 size={13} className="animate-spin text-zinc-500" />
          ) : (
            <>
              {(updatable || opts.component === 'tools') && (
                <button
                  onClick={() => run(opts.component, 'update', opts.latestVersion ?? undefined)}
                  className="rounded-md bg-emerald-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-emerald-500"
                >
                  Update
                </button>
              )}
              {opts.pinned && (
                <button
                  onClick={() => run(opts.component, 'reset')}
                  className="rounded-md border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
                >
                  Reset
                </button>
              )}
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <Section
      title="Runtimes"
      hint="Updates install into a writable location and survive restarts; Reset returns to the bundled version on the next launch."
    >
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <button
            onClick={checkLatest}
            disabled={checking}
            className="flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-300 enabled:hover:border-zinc-600 disabled:opacity-40"
          >
            {checking ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <RefreshCw size={11} />
            )}
            Check for updates
          </button>
        </div>
        {status === null ? (
          <p className="text-[11.5px] text-zinc-600">Loading versions…</p>
        ) : (
          <>
            <div className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="text-[12.5px] font-medium text-zinc-200">Crispin</p>
                <p className="text-[11px] text-zinc-500">{status.app}</p>
              </div>
            </div>
            {row({
              component: 'engine',
              label: 'Engine (oMLX)',
              current: status.engine.omlx ? `omlx ${status.engine.omlx}` : 'not installed yet',
              latestVersion: latest?.omlx ?? null,
              pinned: status.engine.pinned,
              caption: 'Updating restarts the engine (waits for generations to finish).'
            })}
            {row({
              component: 'tools',
              label: 'Tools sidecar',
              current:
                Object.entries(status.tools.packages)
                  .slice(0, 4)
                  .map(([name, version]) => `${name} ${version}`)
                  .join(' · ') || 'not installed yet',
              latestVersion: null,
              pinned: status.tools.pinned,
              caption: 'Update upgrades the top-level deps; restarts the sidecar.'
            })}
            {row({
              component: 'opencode',
              label: 'opencode',
              current: status.opencode.version ?? 'unknown',
              latestVersion: latest?.opencode ?? null,
              pinned: status.opencode.customPath !== null,
              caption: 'Agents respawn with the new binary on the next prompt.'
            })}
          </>
        )}
      </div>
    </Section>
  )
}

function CacheSection() {
  const [info, setInfo] = useState<MethodOutput<'cache.size'> | null>(null)
  const [clearing, setClearing] = useState(false)

  const refresh = (): void => {
    void call('cache.size')
      .then(setInfo)
      .catch(() => {})
  }
  useEffect(refresh, [])

  const clear = (): void => {
    setClearing(true)
    void call('cache.clear')
      .then((r) => {
        pushToast(
          r.ok ? 'info' : 'warn',
          r.ok ? `Cleared ${formatBytes(r.freedBytes)} of KV cache.` : (r.reason ?? 'Engine busy.')
        )
        refresh()
      })
      .catch(toastError)
      .finally(() => setClearing(false))
  }

  return (
    <Section
      title="Engine cache"
      hint="oMLX caches prompt prefixes on disk so later turns skip re-processing. Clearing frees space; the next reply re-processes its context (a slower first response)."
    >
      <div className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-medium text-zinc-200">
            KV cache: {info ? formatBytes(info.bytes) : '…'}
            {info?.maxBytes ? ` / ${formatBytes(info.maxBytes)} cap` : ''}
          </p>
          {info && <p className="truncate text-[10px] text-zinc-700">{info.path}</p>}
        </div>
        <button
          onClick={clear}
          disabled={clearing}
          className="flex shrink-0 items-center gap-1 rounded-md border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 enabled:hover:border-zinc-500 disabled:opacity-40"
        >
          {clearing && <Loader2 size={11} className="animate-spin" />}
          Clear cache
        </button>
      </div>
    </Section>
  )
}

function AboutSection() {
  const version = useSystemStore((s) => s.status?.version)
  const dataDir = useSystemStore((s) => s.status?.dataDir)
  return (
    <Section title="About">
      <p className="text-[12px] text-zinc-500">
        Crispin {version ?? '…'} — local models only; nothing leaves this Mac.
      </p>
      {dataDir && <p className="text-[11px] text-zinc-700">Data: {dataDir}</p>}
    </Section>
  )
}

export default function SettingsTab() {
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.update)

  const update = (patch: Partial<AppSettings>): void => {
    void updateSettings(patch).catch(toastError)
  }

  return (
    <div className="h-full overflow-y-auto">
      {/* In-band sticky header: h-12 row shares the hiddenInset titlebar band and drags the window. */}
      <header className="drag-region sticky top-0 z-10 border-b border-zinc-800/80 bg-[#101013]">
        <div className="mx-auto flex h-12 max-w-3xl items-center px-8">
          <h1 className="text-[13px] font-semibold text-zinc-100">Settings</h1>
        </div>
      </header>
      {settings ? (
        <div className="mx-auto flex max-w-3xl flex-col gap-10 px-8 pb-16 pt-6">
          <ProfileSection settings={settings} update={update} />
          <InstructionsSection settings={settings} update={update} />
          <ModulesSection settings={settings} update={update} />
          <ModelsSection settings={settings} update={update} />
          <CacheSection />
          <NewsSection settings={settings} update={update} />
          <RuntimesSection />
          <AboutSection />
        </div>
      ) : (
        <p className="px-8 pt-6 text-sm text-zinc-600">Loading…</p>
      )}
    </div>
  )
}
