import { create } from 'zustand'

interface PaletteStore {
  open: boolean
  setOpen: (open: boolean) => void
  toggle: () => void
}

/** Global ⌘K command palette visibility. */
export const usePaletteStore = create<PaletteStore>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open }))
}))
