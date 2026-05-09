import type { Page, Locator } from 'playwright-core'
import type { Action } from '@vostride/agent-qa-core'
import type { RefMap } from './types.js'

const ACTIONS_WITHOUT_REF = new Set(['navigate', 'waitFor', 'delay', 'waitForUrl', 'assert'])

export class ElementResolver {
  constructor(
    private page: Page,
    private refs: RefMap,
  ) {}

  resolve(ref: string): Locator {
    const data = this.refs[ref]
    if (!data) {
      throw new Error(`Unknown ref "${ref}". Available refs: ${Object.keys(this.refs).join(', ') || 'none'}`)
    }

    let locator: Locator
    if (data.name) {
      locator = this.page.getByRole(data.role as any, { name: data.name, exact: true })
    } else {
      locator = this.page.getByRole(data.role as any)
    }

    if (data.nth !== undefined) {
      locator = locator.nth(data.nth)
    }

    return locator
  }

  resolveAction(action: Action): Locator | null {
    if (ACTIONS_WITHOUT_REF.has(action.type)) {
      return null
    }

    if ('ref' in action && typeof action.ref === 'string') {
      return this.resolve(action.ref)
    }

    return null
  }

  async getBoundingBox(ref: string): Promise<{ x: number; y: number; width: number; height: number } | null> {
    try {
      const locator = this.resolve(ref)
      return await locator.boundingBox()
    } catch {
      return null
    }
  }
}
