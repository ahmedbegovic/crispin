import type { CSSProperties } from 'react'
import { create } from 'zustand'

// Renderer-only display preferences for the chat reading area. Persisted to
// localStorage (the first such use in the app) rather than app-settings: these
// are per-eyeball comfort knobs, not synced product state. Driven into the UI as
// CSS custom properties on an ancestor (see chatPrefsVars) so changing them never
// re-renders the memoized MarkdownPart — only the inherited variable updates.

export type ChatTextSize = 'small' | 'default' | 'large'
export type ChatWidth = 'standard' | 'wide'

interface Persisted {
  textSize: ChatTextSize
  width: ChatWidth
  /** Default soft-wrap for code blocks; each block can still override locally. */
  codeWrap: boolean
}

interface ChatPrefsStore extends Persisted {
  setTextSize: (v: ChatTextSize) => void
  setWidth: (v: ChatWidth) => void
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

const DEFAULTS: Persisted = { textSize: 'default', width: 'standard', codeWrap: false }

function load(): Persisted {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULTS
    const p = JSON.parse(raw) as Partial<Persisted>
    return {
      textSize: p.textSize && p.textSize in TEXT_SIZE ? p.textSize : DEFAULTS.textSize,
      width: p.width && p.width in WIDTH ? p.width : DEFAULTS.width,
      codeWrap: typeof p.codeWrap === 'boolean' ? p.codeWrap : DEFAULTS.codeWrap
    }
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
    const { width, codeWrap } = get()
    persist({ textSize, width, codeWrap })
  },
  setWidth: (width) => {
    set({ width })
    const { textSize, codeWrap } = get()
    persist({ textSize, width, codeWrap })
  },
  setCodeWrap: (codeWrap) => {
    set({ codeWrap })
    const { textSize, width } = get()
    persist({ textSize, width, codeWrap })
  }
}))

/** CSS custom properties for the chat content area; pass straight to a `style` prop. */
export function chatPrefsVars(textSize: ChatTextSize, width: ChatWidth): CSSProperties {
  const t = TEXT_SIZE[textSize]
  return { '--chat-fs': t.fs, '--chat-lh': t.lh, '--chat-measure': WIDTH[width] } as CSSProperties
}
