import type { Action } from '../types/platform.js'
import type { MobileRefMap } from './types.js'

const ACTIONS_WITHOUT_REF = new Set(['navigate', 'waitFor', 'delay', 'assert', 'scroll', 'swipe', 'pinch', 'multiTap'])

export class MobileElementResolver {
  constructor(private refs: MobileRefMap) {}

  resolve(ref: string): { role: string; name?: string; bounds: { x: number; y: number; width: number; height: number }; center: { x: number; y: number } } {
    const data = this.refs[ref]
    if (!data) {
      const available = Object.keys(this.refs).join(', ') || 'none'
      throw new Error(`Unknown ref "${ref}". Available refs: ${available}`)
    }

    if (!data.bounds) {
      throw new Error(`Ref "${ref}" (${data.role}${data.name ? ` "${data.name}"` : ''}) has no bounds for coordinate resolution`)
    }

    const center = {
      x: data.bounds.x + data.bounds.width / 2,
      y: data.bounds.y + data.bounds.height / 2,
    }

    return {
      role: data.role,
      name: data.name,
      bounds: data.bounds,
      center,
    }
  }

  resolveAction(action: Action): { bounds: { x: number; y: number; width: number; height: number }; center: { x: number; y: number } } | null {
    if (ACTIONS_WITHOUT_REF.has(action.type)) {
      // scroll/swipe may have optional ref
      if (('ref' in action) && typeof (action as { ref?: string }).ref === 'string') {
        const resolved = this.resolve((action as { ref: string }).ref)
        return { bounds: resolved.bounds, center: resolved.center }
      }
      return null
    }

    if ('ref' in action && typeof (action as { ref?: string }).ref === 'string') {
      const resolved = this.resolve((action as { ref: string }).ref)
      return { bounds: resolved.bounds, center: resolved.center }
    }

    return null
  }
}
