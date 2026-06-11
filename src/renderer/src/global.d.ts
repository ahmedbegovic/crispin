export {}

declare global {
  interface Window {
    crispin: {
      call: (method: string, input: unknown) => Promise<unknown>
      onEvent: (callback: (event: unknown) => void) => () => void
    }
  }
}
