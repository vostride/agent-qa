import { describe, it, expect } from 'vitest'
import { getFilenameError, getWorkspaceFilenameError, isValidTestFilename } from '../filename-validation.js'

describe('getFilenameError', () => {
  describe('empty/whitespace', () => {
    it('returns error for empty string', () => {
      expect(getFilenameError('')).toBe('Filename is required')
    })

    it('returns error for whitespace-only string', () => {
      expect(getFilenameError('   ')).toBe('Filename is required')
    })
  })

  describe('valid flat filenames', () => {
    it('accepts my-test.yaml', () => {
      expect(getFilenameError('my-test.yaml')).toBeNull()
    })

    it('accepts my-test.yml', () => {
      expect(getFilenameError('my-test.yml')).toBeNull()
    })
  })

  describe('valid paths with subdirectories', () => {
    it('accepts tests/web/my-test.yaml', () => {
      expect(getFilenameError('tests/web/my-test.yaml')).toBeNull()
    })

    it('accepts deep/nested/path/test.yml', () => {
      expect(getFilenameError('deep/nested/path/test.yml')).toBeNull()
    })
  })

  describe('path traversal rejection', () => {
    it('rejects ../escape.yaml', () => {
      expect(getFilenameError('../escape.yaml')).toContain('..')
    })

    it('rejects tests/../escape.yaml', () => {
      expect(getFilenameError('tests/../escape.yaml')).toContain('..')
    })

    it('rejects tests/../../escape.yaml', () => {
      expect(getFilenameError('tests/../../escape.yaml')).toContain('..')
    })
  })

  describe('absolute path rejection', () => {
    it('rejects /absolute/path.yaml', () => {
      const err = getFilenameError('/absolute/path.yaml')
      expect(err).not.toBeNull()
      expect(err!.toLowerCase()).toContain('absolute')
    })
  })

  describe('empty segment rejection', () => {
    it('rejects tests//double-slash.yaml', () => {
      const err = getFilenameError('tests//double-slash.yaml')
      expect(err).not.toBeNull()
      expect(err!.toLowerCase()).toContain('empty segment')
    })
  })

  describe('extension validation', () => {
    it('rejects tests/no-extension', () => {
      const err = getFilenameError('tests/no-extension')
      expect(err).not.toBeNull()
      expect(err!.toLowerCase()).toContain('.yaml')
    })
  })

  describe('invalid characters', () => {
    it('rejects tests/bad chars!.yaml', () => {
      const err = getFilenameError('tests/bad chars!.yaml')
      expect(err).not.toBeNull()
    })
  })

  describe('suite extension compatibility', () => {
    it('does not reject my-suite.suite.yaml', () => {
      expect(getFilenameError('my-suite.suite.yaml')).toBeNull()
    })
  })
})

describe('isValidTestFilename backward compat', () => {
  it('returns true for my-test.yaml', () => {
    expect(isValidTestFilename('my-test.yaml')).toBe(true)
  })

  it('returns false for ../bad.yaml', () => {
    expect(isValidTestFilename('../bad.yaml')).toBe(false)
  })
})

describe('getWorkspaceFilenameError', () => {
  it('accepts paths matching workspace.testMatch', () => {
    expect(getWorkspaceFilenameError(
      'specs/web/login.yaml',
      ['specs/web/**/*.yaml'],
      'testMatch',
    )).toBeNull()
  })

  it('rejects paths outside workspace.testMatch', () => {
    expect(getWorkspaceFilenameError(
      'tests/login.yaml',
      ['specs/web/**/*.yaml'],
      'testMatch',
    )).toBe("File path must match one of your workspace's testMatch patterns (specs/web/**/*.yaml)")
  })

  it('requires configured workspace patterns', () => {
    expect(getWorkspaceFilenameError('specs/web/login.yaml', [], 'testMatch'))
      .toBe('workspace.testMatch must contain at least one pattern')
    expect(getWorkspaceFilenameError('suites/smoke.suite.yaml', undefined, 'suiteMatch'))
      .toBe('workspace.suiteMatch must contain at least one pattern')
  })

  it('keeps base path safety validation before pattern checks', () => {
    expect(getWorkspaceFilenameError('../escape.yaml', ['**/*.yaml'], 'testMatch')).toContain('..')
  })
})
