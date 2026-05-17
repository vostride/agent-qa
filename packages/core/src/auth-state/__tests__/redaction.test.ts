import { describe, expect, it } from 'vitest'
import { SecretRedactor, SecretStore } from '../../agent/secrets.js'
import {
  AUTH_STATE_REDACTION_MARKER,
  redactAuthStateString,
  redactAuthStateValue,
} from '../redaction.js'

const runtimeAuthState = {
  version: 1,
  kind: 'web' as const,
  targetName: 'staging-web',
  stateName: 'admin',
  capturedAt: '2026-05-17T00:00:00.000Z',
  storageStatePath: '/Users/me/project/.agent-qa/auth-states/staging-web/admin/storage-state.json',
}

const storageState = {
  cookies: [{ name: 'sid', value: 'cookie-secret', domain: 'example.com', path: '/' }],
  origins: [{
    origin: 'https://example.com',
    localStorage: [{ name: 'token', value: 'local-storage-secret' }],
    indexedDB: [{ name: 'auth-db', value: 'indexed-db-secret' }],
  }],
}

describe('auth-state redaction', () => {
  it('redacts structured selected auth state names, paths, and payload shapes', () => {
    const value = {
      use: { authState: { name: 'admin', load: false, capture: true } },
      platformConfig: { authState: runtimeAuthState },
      storageStatePath: runtimeAuthState.storageStatePath,
      payload: storageState,
    }

    const redacted = redactAuthStateValue(value)
    const serialized = JSON.stringify(redacted)

    expect(redacted.use.authState).toBe(AUTH_STATE_REDACTION_MARKER)
    expect(redacted.platformConfig.authState).toBe(AUTH_STATE_REDACTION_MARKER)
    expect(redacted.storageStatePath).toBe(AUTH_STATE_REDACTION_MARKER)
    expect(redacted.payload).toBe(AUTH_STATE_REDACTION_MARKER)
    expect(serialized).not.toContain('admin')
    expect(serialized).not.toContain(runtimeAuthState.storageStatePath)
    expect(serialized).not.toContain('cookie-secret')
    expect(serialized).not.toContain('local-storage-secret')
    expect(serialized).not.toContain('indexed-db-secret')
  })

  it('preserves auth-state management metadata and configured directory', () => {
    const metadata = {
      version: 1,
      kind: 'web',
      target: 'staging-web',
      name: 'admin',
      capturedAt: '2026-05-17T00:00:00.000Z',
    }

    expect(redactAuthStateValue({
      authState: metadata,
      services: { authState: { dir: '.agent-qa/auth-states' } },
      authStates: [metadata],
    })).toEqual({
      authState: metadata,
      services: { authState: { dir: '.agent-qa/auth-states' } },
      authStates: [metadata],
    })
  })

  it('redacts hook env JSON, hook-visible paths, and storage-state JSON strings', () => {
    const hookJson = JSON.stringify({
      version: 1,
      kind: 'web',
      target: 'staging-web',
      name: 'admin',
      capturedAt: '2026-05-17T00:00:00.000Z',
      storageStatePath: '/workspace/.agent-qa-auth-state/storage-state.json',
    })
    const storageJson = JSON.stringify(storageState)

    expect(redactAuthStateString(hookJson)).toBe(AUTH_STATE_REDACTION_MARKER)
    expect(redactAuthStateString(storageJson)).toBe(AUTH_STATE_REDACTION_MARKER)
    expect(redactAuthStateString(`path=/workspace/.agent-qa-auth-state/storage-state.json`))
      .toBe(`path=${AUTH_STATE_REDACTION_MARKER}`)
  })

  it('redacts YAML and JSON source snippets that select auth state', () => {
    expect(redactAuthStateString('use:\n  authState: admin\nsteps: []'))
      .toContain(`authState: ${AUTH_STATE_REDACTION_MARKER}`)
    expect(redactAuthStateString('{"use":{"authState":"admin"}}'))
      .toContain(`"authState":"${AUTH_STATE_REDACTION_MARKER}"`)
    const objectYaml = redactAuthStateString('use:\n  authState:\n    name: admin\n    load: false\n    capture: true\nsteps: []')
    expect(objectYaml).toContain(AUTH_STATE_REDACTION_MARKER)
    expect(objectYaml).not.toContain('admin')
    expect(redactAuthStateString('{"use":{"authState":{"name":"admin","load":false,"capture":true}}}'))
      .toContain(`"authState":"${AUTH_STATE_REDACTION_MARKER}"`)
  })

  it('composes with SecretRedactor and redacts auth-like reporting keys', () => {
    const secretStore = new SecretStore({ API_KEY: 'raw-secret' })
    const redacted = redactAuthStateValue({
      message: 'using raw-secret',
      variables: {
        ACCESS_TOKEN: 'hook-token',
        csrf: 'csrf-token',
        visible: 'not-sensitive',
      },
    }, {
      secretRedactor: new SecretRedactor(secretStore),
    })

    expect(redacted.message).toBe('using [secret]')
    expect(redacted.variables.ACCESS_TOKEN).toBe(AUTH_STATE_REDACTION_MARKER)
    expect(redacted.variables.csrf).toBe(AUTH_STATE_REDACTION_MARKER)
    expect(redacted.variables.visible).toBe('not-sensitive')
  })
})
