import { describe, expect, it } from 'vitest'

import {
  connectionSecretNames,
  projectConfigRemotes,
  projectRemotesForDisplay,
  remoteEntryIssues,
  remoteLabel,
  type RemoteEntryLike,
} from '../config/remote'

const grid: RemoteEntryLike = {
  name: 'grid',
  protocol: 'playwright',
  url: 'wss://grid.example.com/playwright',
}
const debuggerRemote: RemoteEntryLike = {
  name: 'debugger',
  protocol: 'cdp',
  url: 'wss://cdp.example.com/browser/cdp',
}

function messages(entry: RemoteEntryLike): string[] {
  return remoteEntryIssues(entry).map((issue) => issue.message)
}

function issues(entry: RemoteEntryLike): { path: string; message: string }[] {
  return remoteEntryIssues(entry).map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }))
}

function needsReference(name: string, section: string, path: string): string {
  return `Remote ${name}: ${section} "${path}" names a credential, so its value must be a {{secret:NAME}} reference.`
}

const CAPS = { browser: 'chromium', 'grid:options': { accessKey: 'literal-9f3e' } }
const CAPS_WITH_REFERENCE = {
  browser: 'chromium',
  'grid:options': { accessKey: '{{secret:GRID_KEY}}' },
}

describe('the remote credential names', () => {
  it('needs a reference under jwt, bearer, credential, signature, passwd and pwd names', () => {
    expect(
      issues({ ...debuggerRemote, url: 'wss://cdp.example.com/browser/cdp?jwt=literal-1a2b' }),
    ).toEqual([{ path: 'url', message: needsReference('debugger', 'url query', 'jwt') }])
    expect(
      messages({
        ...grid,
        headers: { 'X-Bearer': 'literal', 'X-Signature': 'literal' },
        query: { jwt: 'literal', 'x-credential': 'literal', passwd: 'literal', pwd: 'literal' },
      }),
    ).toEqual([
      needsReference('grid', 'headers', 'X-Bearer'),
      needsReference('grid', 'headers', 'X-Signature'),
      needsReference('grid', 'query', 'jwt'),
      needsReference('grid', 'query', 'x-credential'),
      needsReference('grid', 'query', 'passwd'),
      needsReference('grid', 'query', 'pwd'),
    ])
    expect(
      messages({
        ...grid,
        url: 'wss://grid.example.com/playwright?jwt={{secret:GRID_JWT}}',
        headers: { 'X-Bearer': '{{secret:GRID_BEARER}}', 'X-Signature': '{{secret:GRID_SIG}}' },
        query: { 'x-credential': '{{secret:GRID_CRED}}', passwd: '{{secret:GRID_PW}}' },
      }),
    ).toEqual([])
  })

  it('takes a literal under names that only contain sig, pass or auth, such as signal, bypass and author', () => {
    expect(
      messages({
        ...grid,
        query: { signal: 'on', design: 'flat', bypass: 'cache', compass: 'north', author: 'qa' },
        headers: { 'X-Signal': 'on' },
      }),
    ).toEqual([])
  })

  it('sends a jwt over ws:// only to this machine', () => {
    expect(
      messages({ ...debuggerRemote, url: 'ws://cdp.example.com/browser/cdp?jwt=literal' }),
    ).toEqual([
      needsReference('debugger', 'url query', 'jwt'),
      'Remote debugger: credentials go over ws:// only to this machine. Use wss:// for cdp.example.com.',
    ])
    expect(
      messages({ ...debuggerRemote, url: 'ws://127.0.0.1:9222/devtools?jwt={{secret:J}}' }),
    ).toEqual([])
  })
})

describe('credential names inside a JSON query value', () => {
  it('refuses a literal under a credential name inside a JSON value written in the url, at any depth, encoded or not', () => {
    const sentence = needsReference('grid', 'url query', 'caps.grid:options.accessKey')
    const encoded = `${grid.url}?caps=${encodeURIComponent(JSON.stringify(CAPS))}`
    const plain = `${grid.url}?caps=${JSON.stringify(CAPS)}`
    expect(issues({ ...grid, url: encoded })).toEqual([{ path: 'url', message: sentence }])
    expect(issues({ ...grid, url: plain })).toEqual([{ path: 'url', message: sentence }])
    const list = encodeURIComponent('[{"accessKey":"literal"}]')
    expect(messages({ ...grid, url: `${grid.url}?caps=${list}` })).toEqual([
      needsReference('grid', 'url query', 'caps.0.accessKey'),
    ])
  })

  it('reads an encoded JSON value in the url that also holds a reference as written', () => {
    const reference = '{{secret:GRID_USER}}'
    const json = encodeURIComponent(JSON.stringify({ user: reference, accessKey: 'literal-77aa' }))
    const url = `${grid.url}?caps=${json.replace(encodeURIComponent(reference), reference)}`
    expect(messages({ ...grid, url })).toEqual([
      needsReference('grid', 'url query', 'caps.accessKey'),
    ])
  })

  it('refuses a JSON string under query with the path and sentence of the same value written as a map', () => {
    const asMap = issues({ ...grid, query: { capabilities: CAPS } })
    expect(asMap).toEqual([
      {
        path: 'query.capabilities.grid:options.accessKey',
        message: needsReference('grid', 'query', 'capabilities.grid:options.accessKey'),
      },
    ])
    expect(issues({ ...grid, query: { capabilities: JSON.stringify(CAPS) } })).toEqual(asMap)
    expect(messages({ ...grid, query: { caps: { opts: '{"token":"abc"}' } } })).toEqual([
      needsReference('grid', 'query', 'caps.opts.token'),
    ])
    expect(
      messages({ ...grid, query: { caps: JSON.stringify({ opts: '{"token":"abc"}' }) } }),
    ).toEqual([needsReference('grid', 'query', 'caps.opts.token')])
    const token = { value: '{{secret:GRID_TOKEN}}', note: 'literal' }
    expect(issues({ ...grid, query: { token: JSON.stringify(token) } })).toEqual(
      issues({ ...grid, query: { token } }),
    )
    expect(messages({ ...grid, query: { token } })).toEqual([
      needsReference('grid', 'query', 'token'),
    ])
  })

  it('accepts JSON values whose credential names hold references, and names them as connection secrets', () => {
    const encoded =
      encodeURIComponent('{"grid:options":{"accessKey":"') +
      '{{secret:URL_KEY}}' +
      encodeURIComponent('"}}')
    const entries: RemoteEntryLike[] = [
      { ...grid, url: `${grid.url}?caps=${encoded}` },
      {
        ...grid,
        name: 'plain',
        url: 'wss://grid.example.com/playwright?caps={"accessKey":"{{secret:PLAIN_KEY}}"}',
      },
      { ...grid, name: 'mapped', query: { capabilities: JSON.stringify(CAPS_WITH_REFERENCE) } },
    ]
    for (const entry of entries) expect(messages(entry), entry.name).toEqual([])
    expect(connectionSecretNames(entries).sort()).toEqual(['GRID_KEY', 'PLAIN_KEY', 'URL_KEY'])
  })

  it('leaves a value that is not well-formed JSON as it is', () => {
    expect(
      messages({
        ...grid,
        url: 'wss://grid.example.com/playwright?caps={accessKey:abc}',
        query: {
          caps: '{"accessKey": "abc"',
          note: '[draft]',
          session: '{{secret:GRID_SESSION}}',
          client: '{{playwright:version}}',
        },
      }),
    ).toEqual([])
  })

  it('counts a credential name inside a JSON query value toward the cleartext rule', () => {
    const cleartext =
      'Remote grid: credentials go over ws:// only to this machine. Use wss:// for grid.example.com.'
    expect(
      messages({
        ...grid,
        url: 'ws://grid.example.com/playwright',
        query: { caps: '{"accessKey":"literal"}' },
      }),
    ).toEqual([needsReference('grid', 'query', 'caps.accessKey'), cleartext])
    const json = encodeURIComponent('{"accessKey":"literal"}')
    expect(messages({ ...grid, url: `ws://grid.example.com/playwright?caps=${json}` })).toEqual([
      needsReference('grid', 'url query', 'caps.accessKey'),
      cleartext,
    ])
    expect(
      messages({
        ...grid,
        url: 'ws://127.0.0.1:3000/playwright',
        query: { caps: JSON.stringify(CAPS_WITH_REFERENCE) },
      }),
    ).toEqual([])
  })

  it('shows a remote whose url and query carry a jwt and JSON values by name, protocol and origin only', () => {
    const remotes: RemoteEntryLike[] = [
      { ...debuggerRemote, url: 'wss://cdp.example.com/browser/cdp?jwt={{secret:CDP_JWT}}' },
      {
        ...grid,
        url: `${grid.url}?caps=${encodeURIComponent(JSON.stringify(CAPS_WITH_REFERENCE))}`,
        query: { capabilities: JSON.stringify(CAPS_WITH_REFERENCE) },
      },
    ]
    const shown = [
      { name: 'debugger', protocol: 'cdp', url: 'wss://cdp.example.com:443' },
      { name: 'grid', protocol: 'playwright', url: 'wss://grid.example.com:443' },
    ]
    expect(projectRemotesForDisplay(remotes)).toEqual(shown)
    expect(projectConfigRemotes({ registry: { remotes } })).toEqual({
      registry: { remotes: shown },
    })
    expect(remotes.map(remoteLabel)).toEqual([
      'debugger (cdp wss://cdp.example.com:443)',
      'grid (playwright wss://grid.example.com:443)',
    ])
  })
})
