import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // CI runners are several times slower than a dev machine, and many tests run near 5s.
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
