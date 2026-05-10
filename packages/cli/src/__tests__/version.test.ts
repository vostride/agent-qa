import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { getAgentQaVersion } from '@vostride/agent-qa-core'
import { VERSION } from '../index.js'

describe('agent-qa CLI version', () => {
  it('uses the shared package metadata version for CLI --version output', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'),
    ) as { version: string }

    expect(VERSION).toBe(getAgentQaVersion())
    expect(VERSION).toBe(manifest.version)
  })
})
