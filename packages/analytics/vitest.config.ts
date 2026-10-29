import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 2026-08-17. The `node` environment is not incidental: the DNT
    // zero-network differential plan 06 lands here intercepts Node's global fetch through
    // undici's global dispatcher, and RESEARCH A2 records that `happy-dom` breaks that
    // interception outright — a cell that observes zero connection attempts because nothing
    // was ever intercepted looks exactly like the proof it is supposed to be.
    environment: 'node',
    // The 5s vitest default is tuned for a fast dev machine. A 2-core CI runner is
    // 3-6x slower and 395 workspace tests sit in the 0.7-5s band, several within 150ms
    // of the default. Matches the precedent knowledge-local already set.
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
