import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'

import { carriesNonJsonBody } from '../server/body-parser.js'

function requestWith(headers: Record<string, string>): IncomingMessage {
  return { headers } as IncomingMessage
}

describe('a request body is JSON only when it says so', () => {
  it.each([
    ['no length and no transfer encoding', {}],
    ['no length with a text type', { 'content-type': 'text/plain' }],
    ['a zero length', { 'content-length': '0' }],
    ['a zero length with a text type', { 'content-length': '0', 'content-type': 'text/plain' }],
    ['a JSON body', { 'content-length': '7', 'content-type': 'application/json' }],
    ['an upper-case JSON type', { 'content-length': '7', 'content-type': 'APPLICATION/JSON' }],
    [
      'a JSON type with a charset',
      { 'content-length': '7', 'content-type': 'application/json; charset=utf-8' },
    ],
    [
      'a chunked JSON body',
      { 'transfer-encoding': 'chunked', 'content-type': 'application/json' },
    ],
  ] as const)('passes %s', (_case, headers) => {
    expect(carriesNonJsonBody(requestWith(headers))).toBe(false)
  })

  it.each([
    ['a chunked body with no type', { 'transfer-encoding': 'chunked' }],
    ['a body with no type', { 'content-length': '7' }],
    [
      'a text body as fetch labels a string',
      { 'content-length': '7', 'content-type': 'text/plain;charset=UTF-8' },
    ],
    [
      'a form body',
      { 'content-length': '7', 'content-type': 'application/x-www-form-urlencoded' },
    ],
    [
      'a multipart body',
      { 'content-length': '7', 'content-type': 'multipart/form-data; boundary=x' },
    ],
    ['a +json body', { 'content-length': '7', 'content-type': 'application/merge-patch+json' }],
  ] as const)('refuses %s', (_case, headers) => {
    expect(carriesNonJsonBody(requestWith(headers))).toBe(true)
  })
})
