import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

// Mirrors the tsconfig path aliases so tests resolve @shared/@main/@ like the app.
// Vite's transform also handles the `?raw` SQL imports the migration runner uses.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'src/shared'),
      '@main': resolve(import.meta.dirname, 'src/main'),
      '@': resolve(import.meta.dirname, 'src/renderer/src')
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
})
