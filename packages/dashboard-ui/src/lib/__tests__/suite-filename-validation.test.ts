import { describe, it, expect } from 'vitest'
import { getSuiteFilenameError } from '../suite-filename-validation'

describe('getSuiteFilenameError', () => {
  const patterns = ['**/*.suite.yaml', 'suites/**/*.yaml']

  it('passes matching paths', () => {
    expect(getSuiteFilenameError('my.suite.yaml', patterns)).toBeNull()
    expect(getSuiteFilenameError('suites/web/smoke.suite.yaml', patterns)).toBeNull()
    expect(getSuiteFilenameError('suites/web/sub/deep.yaml', patterns)).toBeNull()
  })

  it('rejects paths that match no glob', () => {
    expect(getSuiteFilenameError('tests/foo.yaml', patterns)).toMatch(/suiteMatch/i)
    expect(getSuiteFilenameError('config.yaml', patterns)).toMatch(/suiteMatch/i)
  })

  it('delegates path traversal to getFilenameError', () => {
    expect(getSuiteFilenameError('../evil.suite.yaml', patterns)).toMatch(/\.\./)
  })

  it('delegates absolute paths to getFilenameError', () => {
    expect(getSuiteFilenameError('/abs/foo.suite.yaml', patterns)).toMatch(/absolute/i)
  })

  it('requires configured suiteMatch patterns', () => {
    expect(getSuiteFilenameError('my.yaml', [])).toBe('workspace.suiteMatch must contain at least one pattern')
    expect(getSuiteFilenameError('my.yaml', undefined)).toBe('workspace.suiteMatch must contain at least one pattern')
    expect(getSuiteFilenameError('my.suite.yaml', [])).toBe('workspace.suiteMatch must contain at least one pattern')
  })

  it('rejects empty filename', () => {
    expect(getSuiteFilenameError('', patterns)).toMatch(/required/i)
  })
})
