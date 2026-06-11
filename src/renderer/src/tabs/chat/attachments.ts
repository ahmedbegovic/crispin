const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif'])

export function extOf(path: string): string {
  return path.split('.').pop()?.toLowerCase() ?? ''
}

export function kindForPath(path: string): 'image' | 'document' {
  return IMAGE_EXTS.has(extOf(path)) ? 'image' : 'document'
}

export function basename(path: string): string {
  return path.split('/').pop() ?? path
}

/**
 * Resolve the absolute filesystem path of a dropped/picked File. File.path was
 * removed in Electron 32+, and the preload doesn't expose webUtils.getPathForFile
 * yet, so this can return null — callers must surface that instead of sending a
 * bogus path to main.
 */
export function pathForFile(file: File): string | null {
  const bridge = window.crispin as typeof window.crispin & {
    getPathForFile?: (file: File) => string
  }
  if (typeof bridge.getPathForFile === 'function') {
    const path = bridge.getPathForFile(file)
    if (path) return path
  }
  const legacy = (file as File & { path?: string }).path
  return legacy && legacy.length > 0 ? legacy : null
}

/** file:// URL for <img>; encodeURI keeps slashes but escapes spaces etc. */
export function fileUrl(path: string): string {
  return `file://${encodeURI(path)}`
}
