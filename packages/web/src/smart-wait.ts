import type { Page } from 'playwright-core'

export interface SmartWaitOptions {
  timeout?: number
}

const LOADING_SELECTORS = [
  '[aria-busy="true"]',
  '[aria-label*="loading" i]',
  '.loading', '.spinner', '.skeleton',
  '[data-loading]', '[data-testid="loading"]',
  'progress:not([value])',
]

export async function waitForPageReady(page: Page, options?: SmartWaitOptions): Promise<void> {
  const timeout = options?.timeout ?? 10000

  await Promise.race([
    runReadinessChecks(page),
    new Promise<void>(resolve => setTimeout(resolve, timeout)),
  ])
}

// Browser-context functions use (globalThis as any) to access document
// because the Node tsconfig has no DOM lib — these functions serialize and run in browser
function checkLoadingIndicators(selectors: string[]): boolean {
  const doc = (globalThis as any).document
  return selectors.some((sel: string) => doc.querySelector(sel) !== null)
}

function checkLoadingGone(selectors: string[]): boolean {
  const doc = (globalThis as any).document
  return !selectors.some((sel: string) => doc.querySelector(sel))
}

function checkAnimationsRunning(): boolean {
  const doc = (globalThis as any).document
  return doc.getAnimations().filter((a: any) => a.playState === 'running').length > 0
}

function checkAnimationsSettled(): boolean {
  const doc = (globalThis as any).document
  return doc.getAnimations().filter((a: any) => a.playState === 'running').length === 0
}

async function runReadinessChecks(page: Page): Promise<void> {
  // 1. Document ready
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 })
  } catch {
    // Already loaded or timed out — continue
  }

  // 2. Network settle (best effort)
  try {
    await page.waitForLoadState('networkidle', { timeout: 5000 })
  } catch {
    // SPA with websockets or long-polling — proceed anyway
  }

  // 3. Loading indicators gone
  try {
    const hasIndicators = await page.evaluate(checkLoadingIndicators, LOADING_SELECTORS)

    if (hasIndicators) {
      try {
        await page.waitForFunction(checkLoadingGone, LOADING_SELECTORS, { timeout: 3000 })
      } catch {
        // Indicators didn't clear in 3s — proceed anyway
      }
    }
  } catch {
    // page.evaluate failed (navigation in progress, context destroyed) — continue
  }

  // 4. Animations settled
  try {
    const hasRunning = await page.evaluate(checkAnimationsRunning)

    if (hasRunning) {
      try {
        await page.waitForFunction(checkAnimationsSettled, undefined, { timeout: 2000 })
      } catch {
        // Animations didn't settle in 2s — proceed anyway
      }
    }
  } catch {
    // page.evaluate failed — continue
  }
}
