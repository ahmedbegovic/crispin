export {}

declare global {
  interface Window {
    orion: {
      call: (method: string, input: unknown) => Promise<unknown>
      onEvent: (callback: (event: unknown) => void) => () => void
    }
  }
}
