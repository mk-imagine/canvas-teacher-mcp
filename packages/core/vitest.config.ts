import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@canvas-mcp/core': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    },
  },
  test: {
    root: __dirname,
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/setup/msw-server.ts'],
    poolOptions: {
      forks: {
        execArgv: ['--no-warnings'],
      },
    },
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage/unit',
      clean: true,
      exclude: [
        'node_modules/**',
        'dist/**',
        'tests/**',
        '.history/**',
        'packages/teacher/**',
        'src/index.ts',
        'vitest.config.ts',
        '**/*.d.ts',
      ],
    },
  },
})
