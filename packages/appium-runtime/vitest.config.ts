import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // CI runners are several times slower than a dev machine, and many tests run near 5s.
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
