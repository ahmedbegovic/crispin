import type { CSSProperties } from 'react'
import { create } from 'zustand'

// Renderer-only display preferences for the chat reading area. Persisted to
// localStorage (the first such use in the app) rather than app-settings: these
// are per-eyeball comfort knobs, not synced product state. Driven into the UI as
// CSS custom properties on an ancestor (see chatPrefsVars) so changing them never
// re-renders the memoized MarkdownPart — only the inherited variable updates.

export type ChatTextSize = 'small' | 'default' | 'large'
export type ChatWidth = 'standard' | 'wide'
export type ChatDensity = 'comfortable' | 'compact'

interface Persisted {
  textSize: ChatTextSize
  width: ChatWidth
  density: ChatDensity
  /** Default soft-wrap for code blocks; each block can still override locally. */
  codeWrap: boolean
}

interface ChatPrefsStore extends Persisted {
  setTextSize: (v: ChatTextSize) => void
  setWidth: (v: ChatWidth) => void
  setDensity: (v: ChatDensity) => void
  setCodeWrap: (v: boolean) => void
}

const KEY = 'crispin.chatPrefs.v1'

const TEXT_SIZE: Record<ChatTextSize, { fs: string; lh: string }> = {
  small: { fs: '12.5px', lh: '1.65' },
  default: { fs: '13.5px', lh: '1.7' },
  large: { fs: '15px', lh: '1.78' }
}
const WIDTH: Record<ChatWidth, string> = {
  standard: '46rem',
  wide: '54rem'
}
const DENSITY: Record<ChatDensity, { pbMsg: string; myPara: string; ptTurn: string }> = {
  // ptTurn = top padding above each user message — the dominant inter-turn gap,
  // so it carries most of the visible comfortable↔compact difference.
  comfortable: { pbMsg: '1rem', myPara: '0.5rem', ptTurn: '1.5rem' },
  compact: { pbMsg: '0.5rem', myPara: '0.25rem', ptTurn: '0.875rem' }
}

const DEFAULTS: Persisted = {
  textSize: 'default',
  width: 'standard',
  density: 'comfortable',
  codeWrap: false
}

/** Coerce an arbitrary persisted blob into a valid Persisted, defaulting any
 *  missing/invalid field individually — so an upgrade that adds a key (e.g.
 *  density) never drops the user's other saved prefs. Pure + exported for tests. */
export function coercePersisted(raw: unknown): Persisted {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Partial<Persisted>
  return {
    textSize: p.textSize && p.textSize in TEXT_SIZE ? p.textSize : DEFAULTS.textSize,
    width: p.width && p.width in WIDTH ? p.width : DEFAULTS.width,
    density: p.density && p.density in DENSITY ? p.density : DEFAULTS.density,
    codeWrap: typeof p.codeWrap === 'boolean' ? p.codeWrap : DEFAULTS.codeWrap
  }
}

function load(): Persisted {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULTS
    return coercePersisted(JSON.parse(raw))
  } catch {
    return DEFAULTS
  }
}

function persist(p: Persisted): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    /* storage disabled / over quota — prefs just won't survive reload */
  }
}

export const useChatPrefs = create<ChatPrefsStore>((set, get) => ({
  ...load(),
  setTextSize: (textSize) => {
    set({ textSize })
    const { width, density, codeWrap } = get()
    persist({ textSize, width, density, codeWrap })
  },
  setWidth: (width) => {
    set({ width })
    const { textSize, density, codeWrap } = get()
    persist({ textSize, width, density, codeWrap })
  },
  setDensity: (density) => {
    set({ density })
    const { textSize, width, codeWrap } = get()
    persist({ textSize, width, density, codeWrap })
  },
  setCodeWrap: (codeWrap) => {
    set({ codeWrap })
    const { textSize, width, density } = get()
    persist({ textSize, width, density, codeWrap })
  }
}))

/** CSS custom properties for the chat content area; pass straight to a `style` prop. */
export function chatPrefsVars(
  textSize: ChatTextSize,
  width: ChatWidth,
  density: ChatDensity
): CSSProperties {
  const t = TEXT_SIZE[textSize]
  const d = DENSITY[density]
  return {
    '--chat-fs': t.fs,
    '--chat-lh': t.lh,
    '--chat-measure': WIDTH[width],
    '--chat-pb-msg': d.pbMsg,
    '--chat-my-para': d.myPara,
    '--chat-pt-turn': d.ptTurn
  } as CSSProperties
}
