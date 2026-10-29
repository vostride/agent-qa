// Playwright's listeners are those the launch adds to `process.listeners`, compared by identity.

import { existsSync } from 'node:fs'
import { chromium } from 'playwright-core'
import { describe, expect, it } from 'vitest'
import { WebPlatformAdapter } from '../adapter.js'

const WATCHED = ['SIGINT', 'SIGTERM', 'SIGHUP', 'exit'] as const
type Watched = (typeof WATCHED)[number]
type Listener = (...args: unknown[]) => void
type Added = Record<Watched, Listener[]>

function refuseWithoutChromium(): void {
  if (process.platform === 'win32') throw new Error('POSIX run lifecycle required; never skip')
  if (!existsSync(chromium.executablePath())) throw new Error('Playwright Chromium missing; never skip')
}

function listenersOf(event: Watched): Listener[] {
  return process.listeners(event as NodeJS.Signals) as Listener[]
}

function baseline(): Record<Watched, Set<Listener>> {
  return Object.fromEntries(WATCHED.map((event) => [event, new Set(listenersOf(event))])) as Record<
    Watched,
    Set<Listener>
  >
}

function addedSince(before: Record<Watched, Set<Listener>>): Added {
  return Object.fromEntries(
    WATCHED.map((event) => [event, listenersOf(event).filter((listener) => !before[event].has(listener))]),
  ) as Added
}

function counts(added: Added): Record<Watched, number> {
  return Object.fromEntries(WATCHED.map((event) => [event, added[event].length])) as Record<Watched, number>
}

function stillAttached(added: Added): Record<Watched, number> {
  return Object.fromEntries(
    WATCHED.map((event) => [event, added[event].filter((listener) => listenersOf(event).includes(listener)).length]),
  ) as Record<Watched, number>
}

async function launchAndClose(adapter: WebPlatformAdapter): Promise<{ added: Added; afterCleanup: Record<Watched, number> }> {
  const before = baseline()
  const added = await (async () => {
    try {
      await adapter.setup({ platform: 'web', browser: { name: 'chromium', headless: true } })
      return addedSince(before)
    } finally {
      await adapter.cleanup()
    }
  })()
  return { added, afterCleanup: stillAttached(added) }
}

describe('Playwright signal listeners when the host owns its signals', () => {
  it('a browser launched for a host that owns its signals adds no Playwright SIGINT or SIGTERM listener', async () => {
    refuseWithoutChromium()
    const { added, afterCleanup } = await launchAndClose(new WebPlatformAdapter({ hostOwnsSignals: true }))
    const facts = JSON.stringify({ added: counts(added), afterCleanup })
    expect(added.SIGINT.length, facts).toBe(0)
    expect(added.SIGTERM.length, facts).toBe(0)
    expect(added.SIGHUP.length, facts).toBe(0)
    expect(added.exit.length, facts).toBeGreaterThanOrEqual(1)
    expect(afterCleanup, facts).toEqual({ SIGINT: 0, SIGTERM: 0, SIGHUP: 0, exit: 0 })
  }, 60_000)

  it("a browser launched without the option keeps Playwright's SIGINT, SIGTERM and SIGHUP listeners", async () => {
    refuseWithoutChromium()
    const { added, afterCleanup } = await launchAndClose(new WebPlatformAdapter())
    const facts = JSON.stringify({ added: counts(added), afterCleanup })
    expect(added.SIGINT.length, facts).toBe(1)
    expect(added.SIGTERM.length, facts).toBe(1)
    expect(added.SIGHUP.length, facts).toBe(1)
    expect(afterCleanup, facts).toEqual({ SIGINT: 0, SIGTERM: 0, SIGHUP: 0, exit: 0 })
  }, 60_000)
})
