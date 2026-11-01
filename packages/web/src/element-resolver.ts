import type { Page, Locator } from 'playwright-core'
import type { Action, InterimNode, RefBinding } from '@vostride/agent-qa-runner'
import { rowTextOf } from '@vostride/agent-qa-runner'
import type { ElementInfo, Ref } from '@vostride/agent-qa-schema'
import type { RefMap } from './types.js'

const ACTIONS_WITHOUT_REF = new Set(['navigate', 'waitFor', 'delay', 'waitForUrl', 'assertValue'])

// `elements` is index-aligned with `nodes`; a node without a native ref gets no entry.
export function buildRefMap(
  binding: Record<Ref, RefBinding>,
  nodes: InterimNode[],
  nativeRefs: (string | undefined)[],
  elements: readonly ElementInfo[],
  inChildFrame: readonly boolean[] = [],
): RefMap {
  const refs: RefMap = {}
  for (const [ref, bind] of Object.entries(binding)) {
    const node = nodes[bind.index]
    const nativeRef = nativeRefs[bind.index]
    const element = elements[bind.index]
    if (!node || nativeRef === undefined || !element) continue
    const entry: RefMap[string] = { nativeRef, role: node.role, name: node.name ?? '' }
    const rowText = rowTextOf(element, elements)
    if (rowText !== undefined) entry.rowText = rowText
    if (node.bounds !== undefined) entry.bounds = node.bounds
    if (inChildFrame[bind.index] === true) entry.inChildFrame = true
    refs[ref] = entry
  }
  return refs
}

/** Resolves a ref to the aria-ref locator of the element observed under it; never by position. */
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
    return this.page.locator('aria-ref=' + data.nativeRef)
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
