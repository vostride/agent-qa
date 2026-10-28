import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The 5s vitest default is tuned for a fast dev machine. A 2-core CI runner is
    // 3-6x slower and 395 workspace tests sit in the 0.7-5s band, several within 150ms
    // of the default. Matches the precedent knowledge-local already set.
    testTimeout: 30_000,
    include: ['src/**/__tests__/**/*.test.ts'],
    globals: true,
    maxWorkers: 1,
    env: { GITHUB_ACTIONS: '' },
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
      include: ['src/**/*.test-d.ts'],
      ignoreSourceErrors: true,
    },
  },
})
