import { describe, expect, it } from 'vitest'

import { remoteEntryIssues, type RemoteEntryLike } from '../config/remote'

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
