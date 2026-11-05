import { describe, expect, it } from 'vitest'

import { appendsSubscriptionEntry } from '../config/remote'
import {
  pluginValueCredentialIssues,
  SUBSCRIPTION_AUTH_ENTRY_NAME,
  SUBSCRIPTION_AUTH_PACKAGE,
} from '../index'

const AT = ['plugins', 0, 'options']
const LABEL = 'Plugin acme options'

function needsReference(key: string): string {
  return `${LABEL} "${key}" names a credential, so its value must be a {{secret:NAME}} reference.`
}

const SUBSCRIPTION_ENTRY = { name: 'subscription', package: '@vostride/agent-qa-subscription-auth' }
const ACME_ENTRY = { name: 'acme', package: '@vostride/agent-qa-plugin-acme' }

describe('credential values in plugin options and settings', () => {
  it('refuses a literal under a top-level credential key, naming the label and the key', () => {
    expect(pluginValueCredentialIssues({ apiKey: 'literal-41c8', pool: 'eu' }, AT, LABEL)).toEqual([
      { path: [...AT, 'apiKey'], message: needsReference('apiKey') },
    ])
  })

  it('refuses a literal under a nested credential key with its dotted key and full path', () => {
    expect(
      pluginValueCredentialIssues({ auth: { user: 'qa', token: 'literal-77ab' } }, AT, LABEL),
    ).toEqual([{ path: [...AT, 'auth', 'token'], message: needsReference('auth.token') }])
  })

  it('passes a secret reference under a credential key', () => {
    expect(pluginValueCredentialIssues({ apiKey: '{{secret:BS_KEY}}' }, AT, LABEL)).toEqual([])
  })

  it('passes true, false and null under credential keys', () => {
    expect(
      pluginValueCredentialIssues({ apiKey: true, token: false, password: null }, AT, LABEL),
    ).toEqual([])
  })

  it('passes a literal under a key that names no credential', () => {
    expect(pluginValueCredentialIssues({ pool: 'eu-west', retries: 3 }, AT, LABEL)).toEqual([])
  })
})

describe('the subscription entry the auth command may append', () => {
  it('names the subscription-auth package under the name subscription', () => {
    expect(SUBSCRIPTION_AUTH_ENTRY_NAME).toBe('subscription')
    expect(SUBSCRIPTION_AUTH_PACKAGE).toBe('@vostride/agent-qa-subscription-auth')
  })

  it('allows an empty list gaining the subscription entry', () => {
    expect(appendsSubscriptionEntry([], [SUBSCRIPTION_ENTRY])).toBe(true)
  })

  it('allows a missing list gaining the subscription entry', () => {
    expect(appendsSubscriptionEntry(undefined, [SUBSCRIPTION_ENTRY])).toBe(true)
  })

  it('allows the subscription entry appended after an existing entry', () => {
    expect(appendsSubscriptionEntry([ACME_ENTRY], [{ ...ACME_ENTRY }, SUBSCRIPTION_ENTRY])).toBe(
      true,
    )
  })

  it('refuses an appended entry naming another package', () => {
    expect(
      appendsSubscriptionEntry([], [{ name: 'subscription', package: '@acme/agent-qa-auth' }]),
    ).toBe(false)
  })

  it('refuses an appended entry under another name', () => {
    expect(
      appendsSubscriptionEntry([], [{ name: 'acme', package: SUBSCRIPTION_AUTH_PACKAGE }]),
    ).toBe(false)
  })

  it('refuses two appended entries', () => {
    expect(appendsSubscriptionEntry([], [SUBSCRIPTION_ENTRY, ACME_ENTRY])).toBe(false)
    expect(appendsSubscriptionEntry([], [SUBSCRIPTION_ENTRY, SUBSCRIPTION_ENTRY])).toBe(false)
  })

  it('refuses the subscription entry inserted before an existing entry', () => {
    expect(appendsSubscriptionEntry([ACME_ENTRY], [SUBSCRIPTION_ENTRY, ACME_ENTRY])).toBe(false)
  })

  it('refuses an unchanged list', () => {
    expect(appendsSubscriptionEntry([ACME_ENTRY], [ACME_ENTRY])).toBe(false)
    expect(appendsSubscriptionEntry([SUBSCRIPTION_ENTRY], [SUBSCRIPTION_ENTRY])).toBe(false)
  })

  it('refuses an append that also changes an existing entry', () => {
    expect(
      appendsSubscriptionEntry([ACME_ENTRY], [{ ...ACME_ENTRY, options: {} }, SUBSCRIPTION_ENTRY]),
    ).toBe(false)
  })
})
