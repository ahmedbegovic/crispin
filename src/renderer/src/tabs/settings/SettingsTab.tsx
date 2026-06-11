import { useEffect, useState, type ReactNode } from 'react'
import type { AppSettings } from '@shared/ipc'
import type { Feature } from '@shared/types'
import { CORE_MODULES, OPTIONAL_MODULES } from '@shared/modules'
import { MODULE_ICONS } from '@/lib/module-icons'
import { useSettingsStore } from '@/stores/settings'
import { useSystemStore } from '@/stores/system'
import { toastError } from '@/stores/toasts'

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
            placeholder="Orion"
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

function AboutSection() {
  const version = useSystemStore((s) => s.status?.version)
  const dataDir = useSystemStore((s) => s.status?.dataDir)
  return (
    <Section title="About">
      <p className="text-[12px] text-zinc-500">
        Orion {version ?? '…'} — local models only; nothing leaves this Mac.
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
          <AboutSection />
        </div>
      ) : (
        <p className="px-8 pt-6 text-sm text-zinc-600">Loading…</p>
      )}
    </div>
  )
}
