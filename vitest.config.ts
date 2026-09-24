import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // Mirrors the aliases in electron.vite.config.ts and the tsconfigs.
    alias: { '@shared': resolve('src/shared') }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
})
