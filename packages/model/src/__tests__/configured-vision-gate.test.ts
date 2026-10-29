// C439-CONFIGURED-VISION (439 D-19): the vision gate reads the configured `vision` when set and
// otherwise the model capability table, so a model the table does not know is text-only unless
// the config says otherwise.

import { beforeEach, describe, expect, it } from 'vitest'
import type { ModelProfile } from '@vostride/agent-qa-schema'
import { overrideStore } from '../capability/override-store.js'
import { resolveCapabilities } from '../capability/resolve.js'
import { resolveVisionGate, visionFromConfig } from '../vision/resolve-gate.js'

function profile(model: string): ModelProfile {
  return { provider: 'openai-compatible', model, auth: { mode: 'none' } }
}

describe('a configured vision flag and the vision gate', () => {
  beforeEach(() => {
    overrideStore.clear()
  })

  it('a configured vision wins over the capability table', () => {
    expect(visionFromConfig(true, { vision: false })).toBe(true)
    expect(visionFromConfig(false, { vision: true })).toBe(false)
  })

  it('an unset vision follows the capability table', () => {
    expect(visionFromConfig(undefined, resolveCapabilities(profile('gpt-6.1-sol')))).toBe(true)
    const unknown = visionFromConfig(undefined, resolveCapabilities(profile('mystery-local-7b')))
    expect(unknown).toBe(false)
    const gate = resolveVisionGate({ vision: unknown })
    expect(gate.attachImage).toBe(false)
    expect(gate.captureMode).toBe('textOnly')
    expect(gate.promptNote).toBe(
      'Visual screenshot is unavailable for this step. Rely on the accessibility tree for element identification, including roles, names, values, refs, and URLs. Verify functional state from the available structured context rather than purely visual appearance.',
    )
  })
})
