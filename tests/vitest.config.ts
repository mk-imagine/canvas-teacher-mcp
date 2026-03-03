import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@canvas-mcp/core': fileURLToPath(new URL('../packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Integration tests share Canvas state — run files sequentially
    fileParallelism: false,
    setupFiles: ['tests/setup/integration-env.ts'],
    poolOptions: {
      forks: {
        execArgv: ['--no-warnings'],
      },
    },
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage/integration',
      clean: true,
      exclude: [
        'node_modules/**',
        'dist/**',
        'tests/**',
        'scripts/**',
        '.history/**',
        'vitest.config.ts',
      ],
    },
  },
})
