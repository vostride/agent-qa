import { describe, expect, it } from 'vitest'

import {
  basicAuthMaskEntries,
  basicAuthorizationValue,
  SecretRedactor,
  SecretStore,
} from '../secrets.js'

const GRID_KEY = 'a/b+c d"e\\fé'
const PASSWORD = 'pä ss/wörd'
const USER = 'grid-üser'

function jsonBody(value: string): string {
  return JSON.stringify(value).slice(1, -1)
}

const store = new SecretStore([
  ['GRID_KEY', GRID_KEY],
  ['GRID_PASSWORD', PASSWORD],
  ['GRID_USER', USER],
])

describe('the redactor and encoded secret forms', () => {
  it.each([
    ['raw', GRID_KEY],
    ['percent-encoded', encodeURIComponent(GRID_KEY)],
    ['JSON-escaped', jsonBody(GRID_KEY)],
    ['percent-encoded JSON-escaped', encodeURIComponent(jsonBody(GRID_KEY))],
  ])('masks the %s form of a declared value', (_form, written) => {
    const redactor = new SecretRedactor(store)
    expect(redactor.redactString(`sent <${written}> here`)).toBe('sent <[secret:GRID_KEY]> here')
  })

  it('masks a url holding the query built for an object value', () => {
    const caps = { 'grid.accessKey': GRID_KEY, 'client.name': 'agent-qa' }
    const url =
      `ws://127.0.0.1:9000/session?token=${encodeURIComponent(GRID_KEY)}` +
      `&caps=${encodeURIComponent(JSON.stringify(caps))}`

    const masked = new SecretRedactor(store).redactString(`connect ${url} failed`)

    expect(masked).toBe(
      'connect ws://127.0.0.1:9000/session?token=[secret:GRID_KEY]' +
        `&caps=${encodeURIComponent('{"grid.accessKey":"')}[secret:GRID_KEY]` +
        `${encodeURIComponent('","client.name":"agent-qa"}')} failed`,
    )
  })

  it.each([
    ['raw', 'a b/c?d"e'],
    ['percent-encoded', encodeURIComponent('a b/c?d"e')],
    ['JSON-escaped', jsonBody('a b/c?d"e')],
    ['percent-encoded JSON-escaped', encodeURIComponent(jsonBody('a b/c?d"e'))],
  ])('masks the %s form of an extra value under its name', (_form, written) => {
    const redactor = new SecretRedactor(store, [['PLUGIN_LAB', 'a b/c?d"e']])
    expect(redactor.redactString(`sent <${written}> here`)).toBe('sent <[secret:PLUGIN_LAB]> here')
  })

  it('masks a Basic extra pair as given', () => {
    const basic = basicAuthorizationValue('agent', PASSWORD)
    expect(basic).toBe('YWdlbnQ6cMOkIHNzL3fDtnJk')

    const redactor = new SecretRedactor(store, [['GRID_PASSWORD', basic]])

    expect(redactor.redactString(`Authorization: Basic ${basic}`)).toBe(
      'Authorization: Basic [secret:GRID_PASSWORD]',
    )
  })

  it.each([
    [
      'a referenced password, named after it',
      { user: 'agent', password: '{{secret:GRID_PASSWORD}}' },
      [['GRID_PASSWORD', 'YWdlbnQ6cMOkIHNzL3fDtnJk']],
    ],
    [
      'a referenced user with a literal password, named after the user',
      { user: '{{secret:GRID_USER}}', password: 'literal' },
      [['GRID_USER', 'Z3JpZC3DvHNlcjpsaXRlcmFs']],
    ],
    [
      'a referenced user and password, named after the password',
      { user: '{{secret:GRID_USER}}', password: '{{secret:GRID_PASSWORD}}' },
      [['GRID_PASSWORD', 'Z3JpZC3DvHNlcjpww6Qgc3Mvd8O2cmQ=']],
    ],
    ['no reference, no pair', { user: 'agent', password: 'literal' }, []],
    [
      'a reference to an undeclared secret, no pair',
      { user: 'agent', password: '{{secret:MISSING_PASSWORD}}' },
      [],
    ],
  ])('gives the Basic mask entries for %s', (_case, basicAuth, expected) => {
    const entries = basicAuthMaskEntries([{}, { basicAuth }], store)
    expect(entries).toEqual(expected)

    const redactor = new SecretRedactor(store, entries)
    for (const [name, value] of entries) {
      expect(redactor.redactString(`Basic ${value}`)).toBe(`Basic [secret:${name}]`)
    }
  })

  it('makes a store without the named secrets and keeps the rest', () => {
    const steps = store.without(new Set(['GRID_KEY', 'GRID_USER']))

    expect(steps.has('GRID_KEY')).toBe(false)
    expect(steps.has('GRID_USER')).toBe(false)
    expect(steps.get('GRID_PASSWORD')).toBe(PASSWORD)
    expect(steps.count()).toBe(1)
    expect(store.get('GRID_KEY')).toBe(GRID_KEY)
  })

  it('keeps the first name for a value two names share, in every form', () => {
    const shared = new SecretStore([
      ['FIRST', 'same value'],
      ['SECOND', 'same value'],
    ])
    const redactor = new SecretRedactor(shared)

    expect(redactor.redactString('same value')).toBe('[secret:FIRST]')
    expect(redactor.redactString('same%20value')).toBe('[secret:FIRST]')
  })
})
