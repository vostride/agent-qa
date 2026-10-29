import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // A 2-core CI runner is several times slower, and many tests sit near the 5s default.
    testTimeout: 30_000,
    include: ['src/**/__tests__/**/*.test.ts'],
    globals: true,
    typecheck: {
      enabled: true,
      tsconfig: './tsconfig.json',
      include: ['src/**/*.test-d.ts'],
    },
  },
})
