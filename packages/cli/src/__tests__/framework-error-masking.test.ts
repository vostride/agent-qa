import { describe, expect, it } from 'vitest'
import { SecretRedactor, SecretStore } from '@vostride/agent-qa-runner'

import { frameworkErrorTerminalLine } from '../commands/run.js'

describe('the framework error line masks declared values', () => {
  it("the run's framework error line shows a declared value only as its marker", () => {
    const redactor = new SecretRedactor(SecretStore.fromEnvContent('PW_441=Hunter-42-zz\n'))
    const message = 'navigation to https://x.test/?t=Hunter-42-zz failed'

    const masked = frameworkErrorTerminalLine(message, redactor)

    expect(masked).toContain('[secret:PW_441]')
    expect(masked).not.toContain('Hunter-42-zz')
    expect(frameworkErrorTerminalLine(message, undefined)).toBe(`Framework error: ${message}`)
  })
})
