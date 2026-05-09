import { describe, it, expect } from 'vitest'
import { hashStepInstruction } from '../observation.js'

describe('hashStepInstruction', () => {
  it('returns a 16-char hex string', () => {
    const hash = hashStepInstruction({ step: 'Click login' })
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('positional overload still works', () => {
    const hash = hashStepInstruction('Click login', 'web', 'cfg', 'test')
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('produces different hashes for different configContent', () => {
    const a = hashStepInstruction({ step: 'Click login', configContent: 'A', testFileContent: 'test' })
    const b = hashStepInstruction({ step: 'Click login', configContent: 'B', testFileContent: 'test' })
    expect(a).not.toBe(b)
  })

  it('produces different hashes for different testFileContent', () => {
    const a = hashStepInstruction({ step: 'Click login', configContent: 'cfg', testFileContent: 'A' })
    const b = hashStepInstruction({ step: 'Click login', configContent: 'cfg', testFileContent: 'B' })
    expect(a).not.toBe(b)
  })

  it('produces different hashes for different step text', () => {
    const a = hashStepInstruction({ step: 'Click login', configContent: 'cfg' })
    const b = hashStepInstruction({ step: 'Click submit', configContent: 'cfg' })
    expect(a).not.toBe(b)
  })

  it('is deterministic — same inputs produce same hash', () => {
    const inputs = { step: 'Click login', platform: 'web' as const, configContent: 'cfg' }
    expect(hashStepInstruction(inputs)).toBe(hashStepInstruction(inputs))
  })

  it('produces different hashes for different stepIndex', () => {
    const a = hashStepInstruction({ step: 'Click login', stepIndex: 0 })
    const b = hashStepInstruction({ step: 'Click login', stepIndex: 1 })
    expect(a).not.toBe(b)
  })

  it('defaults stepIndex to 0 when omitted', () => {
    const explicit = hashStepInstruction({ step: 'Click', stepIndex: 0 })
    const omitted = hashStepInstruction({ step: 'Click' })
    expect(explicit).toBe(omitted)
  })

  it('produces different hashes for different suiteFileContent', () => {
    const a = hashStepInstruction({ step: 'Click', suiteFileContent: 'suite-a.yaml content' })
    const b = hashStepInstruction({ step: 'Click', suiteFileContent: 'suite-b.yaml content' })
    expect(a).not.toBe(b)
  })

  it('produces different hashes for different suiteTestIndex', () => {
    const a = hashStepInstruction({ step: 'Click', suiteFileContent: 'suite', suiteTestIndex: 0 })
    const b = hashStepInstruction({ step: 'Click', suiteFileContent: 'suite', suiteTestIndex: 1 })
    expect(a).not.toBe(b)
  })

  it('suite run and individual run produce different hashes', () => {
    const individual = hashStepInstruction({ step: 'navigate', testFileContent: 'test.yaml' })
    const inSuite = hashStepInstruction({ step: 'navigate', testFileContent: 'test.yaml', suiteFileContent: 'suite content' })
    expect(individual).not.toBe(inSuite)
  })

  it('same test in different suites produces different hashes', () => {
    const base = { step: 'navigate', testFileContent: 'test.yaml', suiteTestIndex: 0 }
    const a = hashStepInstruction({ ...base, suiteFileContent: 'suite-a' })
    const b = hashStepInstruction({ ...base, suiteFileContent: 'suite-b' })
    expect(a).not.toBe(b)
  })

  it('same test at different suite positions gets different hashes', () => {
    const base = { step: 'navigate', testFileContent: 'test.yaml', suiteFileContent: 'suite', stepIndex: 0 }
    const t0 = hashStepInstruction({ ...base, suiteTestIndex: 0 })
    const t2 = hashStepInstruction({ ...base, suiteTestIndex: 2 })
    expect(t0).not.toBe(t2)
  })

  it('defaults suiteFileContent to empty when omitted', () => {
    const explicit = hashStepInstruction({ step: 'Click', suiteFileContent: '' })
    const omitted = hashStepInstruction({ step: 'Click' })
    expect(explicit).toBe(omitted)
  })

  it('positional overload matches object form for individual runs', () => {
    const positional = hashStepInstruction('Click', 'web', 'cfg', 'test', 2)
    const object = hashStepInstruction({ step: 'Click', platform: 'web', configContent: 'cfg', testFileContent: 'test', stepIndex: 2 })
    expect(positional).toBe(object)
  })
})
