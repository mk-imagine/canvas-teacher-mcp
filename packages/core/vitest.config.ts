import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@canvas-mcp/core': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    },
  },
  test: {
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
