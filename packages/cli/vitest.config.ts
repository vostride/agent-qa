import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The 5s vitest default is tuned for a fast dev machine. A 2-core CI runner is
    // 3-6x slower and 395 workspace tests sit in the 0.7-5s band, several within 150ms
    // of the default. Matches the precedent knowledge-local already set.
    testTimeout: 30_000,
    // Hooks with no budget of their own close browsers, stop spawned dashboards or enumerate
    // every surface. Each awaits the real operation, so the ceiling bounds a hang and asserts
    // nothing; vitest's 10 s default is outrun under load. Hooks that state their own budget
    // keep it.
    hookTimeout: 120_000,
    include: ['src/**/__tests__/**/*.test.ts'],
    env: { GITHUB_ACTIONS: '' },
    globalSetup: ['./src/__tests__/package-folders-unchanged.ts'],
    globals: true,
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
      include: ['src/**/*.test-d.ts'],
    },
  },
})
