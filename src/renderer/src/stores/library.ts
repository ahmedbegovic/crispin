import { create } from 'zustand'
import type { Collection, LibraryDoc } from '@shared/types'
import { call, onEvent } from '@/lib/ipc'

interface LibraryStore {
  collections: Collection[]
  /** Docs per collection; only collections opened in the Library dialog are loaded. */
  docsByCollection: Record<string, LibraryDoc[]>
  initialized: boolean
  init: () => Promise<void>
  refreshCollections: () => Promise<void>
  loadDocs: (collectionId: string) => Promise<void>
  createCollection: (name: string) => Promise<Collection>
  deleteCollection: (collectionId: string) => Promise<void>
  ingest: (collectionId: string, source: { path?: string; url?: string }) => Promise<void>
  deleteDoc: (collectionId: string, docId: string) => Promise<void>
}

function upsertDoc(docs: LibraryDoc[], doc: LibraryDoc): LibraryDoc[] {
  const index = docs.findIndex((d) => d.id === doc.id)
  if (index === -1) return [doc, ...docs]
  return docs.map((d, i) => (i === index ? doc : d))
}

export const useLibraryStore = create<LibraryStore>((set, get) => ({
  collections: [],
  docsByCollection: {},
  initialized: false,

  init: async () => {
    if (get().initialized) return
    set({ initialized: true })
    onEvent('library.docStatus', (event) => {
      set((s) => {
        const docs = s.docsByCollection[event.doc.collectionId]
        if (!docs) return {}
        return {
          docsByCollection: {
            ...s.docsByCollection,
            [event.doc.collectionId]: upsertDoc(docs, event.doc)
          }
        }
      })
      // A finished ingest changes the collection's docCount.
      if (event.doc.status === 'ready' || event.doc.status === 'failed')
        void get()
          .refreshCollections()
          .catch(() => {})
    })
    await get().refreshCollections()
  },

  refreshCollections: async () => {
    const { collections } = await call('library.collections')
    set({ collections })
  },

  loadDocs: async (collectionId) => {
    const { docs } = await call('library.docs', { collectionId })
    set((s) => ({ docsByCollection: { ...s.docsByCollection, [collectionId]: docs } }))
  },

  createCollection: async (name) => {
    const { collection } = await call('library.createCollection', { name })
    set((s) => ({
      collections: [...s.collections, collection],
      docsByCollection: { ...s.docsByCollection, [collection.id]: [] }
    }))
    return collection
  },

  deleteCollection: async (collectionId) => {
    await call('library.deleteCollection', { collectionId })
    set((s) => {
      const { [collectionId]: _, ...docsByCollection } = s.docsByCollection
      return {
        collections: s.collections.filter((c) => c.id !== collectionId),
        docsByCollection
      }
    })
  },

  ingest: async (collectionId, source) => {
    await call('library.ingest', { collectionId, ...source })
    // Pick up the pending row right away instead of waiting for the first event.
    await get().loadDocs(collectionId)
  },

  deleteDoc: async (collectionId, docId) => {
    await call('library.deleteDoc', { docId })
    set((s) => ({
      docsByCollection: {
        ...s.docsByCollection,
        [collectionId]: (s.docsByCollection[collectionId] ?? []).filter((d) => d.id !== docId)
      }
    }))
    await get().refreshCollections()
  }
}))
