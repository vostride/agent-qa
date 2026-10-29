import { describe, expect, test } from 'vitest'
import type { NetworkLogEntry } from '../../result.js'
import { projectNetworkEvidence } from '../network-evidence-policy.js'
import { redactSecretValue, SecretRedactor, SecretStore } from '../../loop/secrets.js'

const identity = (text: string) => text
const record = (extra: Partial<NetworkLogEntry> = {}): NetworkLogEntry => ({
  url: 'https://example.test/api', method: 'POST', status: 200,
  requestHeaders: { 'Content-Type': 'application/json' },
  responseHeaders: { 'content-type': 'application/json' },
  requestBody: '{"request":true}', body: '{"response":true}', startTime: 20, endTime: 30,
  timing: { requestStart: 1, responseEnd: 2 }, ...extra,
})
const project = (extra: Partial<NetworkLogEntry>, mask = identity) =>
  projectNetworkEvidence([record(extra)], mask).records[0]

test('HEADER-CASE: every credential header value passes through the mask as captured, with metadata and order retained', () => {
  const names = ['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key',
    'x-auth-token', 'x-access-token', 'x-csrf-token', 'x-xsrf-token']
  const headers = Object.fromEntries(names.map((name, index) => [index % 2 ? name.toUpperCase() : name, 'fresh-session-value']))
  const seen: string[] = []
  const source = { ...record({ requestHeaders: { ...headers, 'safe-SYNTHETIC': 'value-SYNTHETIC' },
    responseHeaders: headers, url: 'url-SYNTHETIC', method: 'method-SYNTHETIC',
    timing: { 'time-SYNTHETIC': 2 } }), requestSize: 123, responseSize: 456 }
  const result = projectNetworkEvidence([source, record({ status: 404 })], text => {
    seen.push(text)
    return text.replaceAll('SYNTHETIC', '[secret]')
  })
  expect(Object.values(result.records[0].responseHeaders)).toEqual(names.map(() => 'fresh-session-value'))
  expect(result.records[0]).toMatchObject({ url: 'url-[secret]', method: 'method-[secret]',
    requestHeaders: { 'safe-[secret]': 'value-[secret]' }, timing: { 'time-[secret]': 2 },
    startTime: 20, endTime: 30, status: 200, requestSize: 123, responseSize: 456 })
  expect(result.records.map(value => value.status)).toEqual([200, 404])
  expect(seen).toContain('fresh-session-value')
  expect(source.requestHeaders).toEqual({ ...headers, 'safe-SYNTHETIC': 'value-SYNTHETIC' })
})

test('BODY-TYPE: six exact media types admit normalized parameters and reject suffixes, static and ambiguous types', () => {
  for (const type of ['application/json', 'text/html', 'text/plain', 'application/xml', 'text/xml', 'application/x-www-form-urlencoded']) {
    expect(project({ responseHeaders: { 'CONTENT-TYPE': `${type.toUpperCase()}; charset=utf-8` }, body: 'ordinary text' }).body).toBe('ordinary text')
  }
  for (const type of ['application/problem+json', 'application/rss+xml', 'text/javascript', 'application/javascript', 'text/css', 'image/svg+xml', 'font/woff2', 'application/octet-stream', 'application/json,text/plain', '']) {
    expect(project({ responseHeaders: { 'content-type': type } })).not.toHaveProperty('body')
  }
  expect(project({ responseHeaders: { 'content-type': 'application/json', 'Content-Type': 'text/plain' } })).not.toHaveProperty('body')
  expect(project({ responseHeaders: {} })).not.toHaveProperty('body')
})

test('BODY-BYTES: independent UTF-8 input and masked-output limits omit whole bodies without truncation', () => {
  for (const body of ['a'.repeat(32768), 'é'.repeat(16384), '😀'.repeat(8192)]) {
    expect(project({ body, requestBody: body })).toMatchObject({ body, requestBody: body })
    expect(Buffer.byteLength(project({ body }).body!)).toBe(32768)
    expect(project({ body: `${body}a`, requestBody: `${body}a` })).not.toHaveProperty('body')
    expect(project({ body: `${body}a`, requestBody: `${body}a` })).not.toHaveProperty('requestBody')
  }
  const expanding = (text: string) => text.replaceAll('x', '[secret]')
  expect(project({ body: 'x'.repeat(5000), requestBody: 'x'.repeat(5000) }, expanding)).not.toHaveProperty('body')
  expect(project({ body: 'x'.repeat(5000), requestBody: 'x'.repeat(5000) }, expanding)).not.toHaveProperty('requestBody')
  expect(project({ body: 'x'.repeat(40000) }, () => 'small')).not.toHaveProperty('body')
})

test('BODY-REQUEST-INDEPENDENT: response admission never admits an untyped or disallowed request', () => {
  expect(project({ requestHeaders: {} })).not.toHaveProperty('requestBody')
  expect(project({ requestHeaders: { 'content-type': 'image/png' } })).toMatchObject({ body: '{"response":true}' })
  expect(project({ requestHeaders: { 'content-type': 'image/png' } })).not.toHaveProperty('requestBody')
  expect(project({ responseHeaders: {} })).toMatchObject({ requestBody: '{"request":true}' })
  expect(project({ responseHeaders: {} })).not.toHaveProperty('body')
})

test('DATA-URI-OMITTED: embedded image, script, style, font and binary bodies stay excluded in textual envelopes', () => {
  for (const body of ['{"image":"data:image/png;base64,AAAA"}', '<script>alert(1)</script>',
    '<style>body{color:red}</style>', '{"font":"data:font/woff2;base64,AAAA"}',
    'data:application/octet-stream;base64,AAAA', 'binary\u0000payload']) {
    expect(project({ body, requestBody: body })).not.toHaveProperty('body')
    expect(project({ body, requestBody: body })).not.toHaveProperty('requestBody')
  }
})

describe('network evidence masks declared values by name', () => {
  const declaredMask = (declared: Record<string, string>) => {
    const redactor = new SecretRedactor(new SecretStore(declared))
    return (text: string) => redactSecretValue(text, redactor)
  }

  test('an undeclared credential header is recorded as captured', () => {
    const recorded = project({
      requestHeaders: { Authorization: 'Bearer abc123def456ghi789', Cookie: 'sid=cookie-441', 'content-type': 'application/json' },
    }, declaredMask({}))
    expect(recorded.requestHeaders).toEqual({
      Authorization: 'Bearer abc123def456ghi789', Cookie: 'sid=cookie-441', 'content-type': 'application/json',
    })
  })

  test('a declared value in a header or a body is masked by name', () => {
    const body = '{"password":"Hunter-42-zz"}'
    const recorded = project({
      requestHeaders: { 'X-Api': 'Hunter-42-zz', 'content-type': 'application/json' },
      requestBody: body, body,
    }, declaredMask({ PW_441: 'Hunter-42-zz' }))
    expect(recorded.requestHeaders['X-Api']).toBe('[secret:PW_441]')
    expect(recorded.requestBody).toBe('{"password":"[secret:PW_441]"}')
    expect(recorded.body).toBe('{"password":"[secret:PW_441]"}')
    expect(JSON.stringify(recorded)).not.toContain('Hunter-42-zz')
  })
})
