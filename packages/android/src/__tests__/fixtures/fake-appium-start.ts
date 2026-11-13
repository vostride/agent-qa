import type { AppiumServer } from '@vostride/agent-qa-appium-runtime'
import { vi } from 'vitest'

export function fakeAppiumStart() {
  const stop = vi.fn(async () => {})
  const start = vi.fn(
    async (): Promise<AppiumServer> => ({
      url: 'http://127.0.0.1:50123',
      exited: new Promise<void>(() => {}),
      stop,
    }),
  )
  return { start, stop }
}
