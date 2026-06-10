import { handle } from '../ipc/router'
import type { LibraryService } from '../services/library-service'

/** Registers every library.* IPC method. */
export function registerLibraryFeature(library: LibraryService): void {
  handle('library.collections', () => ({ collections: library.collections() }))

  handle('library.createCollection', ({ name }) => ({
    collection: library.createCollection(name)
  }))

  handle('library.deleteCollection', async ({ collectionId }) => {
    await library.deleteCollection(collectionId)
    return { ok: true }
  })

  handle('library.docs', ({ collectionId }) => ({ docs: library.docs(collectionId) }))

  handle('library.ingest', ({ collectionId, path, url }) => ({
    docId: library.ingest({ collectionId, path, url })
  }))

  handle('library.deleteDoc', async ({ docId }) => {
    await library.deleteDoc(docId)
    return { ok: true }
  })
}
