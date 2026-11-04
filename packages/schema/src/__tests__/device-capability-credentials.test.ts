import { describe, expect, it } from 'vitest'

import { capabilityCredentialIssues } from '../index'

const AT = ['registry', 'devices', 'galaxy-farm', 'capabilities']

function needsReference(path: string): string {
  return `capabilities "${path}" names a credential, so its value must be a {{secret:NAME}} reference.`
}

function messages(capabilities: unknown): string[] {
  return capabilityCredentialIssues(capabilities, AT).map((issue) => issue.message)
}

describe('credential names in capabilities', () => {
  it('refuses a literal under a vendor option that names a credential, at its own path', () => {
    expect(
      capabilityCredentialIssues(
        { 'farm:options': { userName: 'qa', accessKey: 'literal-41c8' } },
        AT,
      ),
    ).toEqual([
      {
        path: [...AT, 'farm:options', 'accessKey'],
        message: needsReference('farm:options.accessKey'),
      },
    ])
  })

  it('walks appium:options like any other object, at any depth', () => {
    expect(
      messages({
        'appium:options': { unlockKey: '1234', nested: { list: [{ authToken: 'literal' }] } },
      }),
    ).toEqual([
      needsReference('appium:options.unlockKey'),
      needsReference('appium:options.nested.list.0.authToken'),
    ])
  })

  it('takes literal paths, aliases and strategies that only contain key, with or without a vendor prefix', () => {
    expect(
      messages({
        'appium:sendKeyStrategy': 'oneByOne',
        'appium:keystorePath': 'keys/release.jks',
        'appium:keyAlias': 'release',
        'appium:keychainPath': '/tmp/agent.keychain',
        'appium:keychainsExcludePatterns': '*.keychain',
        'appium:options': { keystorePath: 'keys/debug.jks', keyAlias: 'debug' },
      }),
    ).toEqual([])
  })

  it('refuses a literal keystore, key or keychain password', () => {
    expect(
      messages({
        'appium:keystorePassword': 'literal',
        'appium:keyPassword': 'literal',
        'appium:keychainPassword': 'literal',
      }),
    ).toEqual([
      needsReference('appium:keystorePassword'),
      needsReference('appium:keyPassword'),
      needsReference('appium:keychainPassword'),
    ])
  })

  it('refuses a number under a credential name', () => {
    expect(messages({ 'farm:options': { accessKey: 4417 } })).toEqual([
      needsReference('farm:options.accessKey'),
    ])
  })

  it('takes true, false and null under a credential name as options', () => {
    expect(
      messages({
        'appium:useKeystore': true,
        'appium:autoFillPasswords': false,
        'farm:options': { accessKey: null, keyOptions: { rotate: true } },
      }),
    ).toEqual([])
  })

  it('takes a reference under a credential name', () => {
    expect(
      messages({
        'farm:options': { accessKey: '{{secret:FARM_KEY}}' },
        'appium:keystorePassword': '{{secret:KEYSTORE_PASSWORD}}',
      }),
    ).toEqual([])
  })
})
