import type { MaskFn } from '@vostride/agent-qa-schema'

import type { FunctionDeps } from '../spec.js'

// Unbound refuses here, and the mask is probed once so the refusal never depends on run content.
export function requireSecretMask(deps: FunctionDeps, functionId: string): MaskFn {
  const mask = deps.secretMask
  if (mask === undefined) {
    throw new Error(`${functionId} cannot mask run text: this host binds no declared-secret mask.`)
  }
  mask('')
  return mask
}
