import { afterEach, describe, expect, it } from 'vitest'
import { PluginError } from '../define-plugin.js'
import { startLoopbackFake, type LoopbackFake } from '../testing/index.js'
import { checkEndpoints, createVendorApi, vendorFailureKind } from '../vendor-api.js'

const fakes: LoopbackFake[] = []

afterEach(async () => {
  await Promise.all(fakes.splice(0).map((fake) => fake.close()))
})

async function start(routes: Parameters<typeof startLoopbackFake>[0]['routes']) {
  const fake = await startLoopbackFake({ routes })
  fakes.push(fake)
  return fake
}

async function failureOf(
  reply: { status: number; json?: unknown; text?: string; headers?: Record<string, string> },
  input: { kinds?: Parameters<typeof vendorFailureKind>[1] } = {},
) {
  const fake = await start({ 'POST /things': [reply] })
  const api = createVendorApi({ vendor: 'Acme', baseUrl: fake.url, ...input })
  const response = await api.send('POST', 'things')
  return api.failure(response, 'POST /things')
}

function refusalOf(run: () => void): PluginError {
  try {
    run()
  } catch (error) {
    if (error instanceof PluginError) return error
    throw error
  }
  throw new Error('expected a refusal')
}

describe('vendorFailureKind', () => {
  it('reads no answer as unreachable, 401 as auth, 429 as capacity and any other status as refused', () => {
    expect(vendorFailureKind(undefined)).toBe('unreachable')
    expect(vendorFailureKind(401)).toBe('auth')
    expect(vendorFailureKind(429)).toBe('capacity')
    for (const status of [400, 403, 404, 500, 529]) {
      expect(vendorFailureKind(status)).toBe('refused')
    }
  })

  it("lets a plugin's own kinds add statuses and override the defaults", () => {
    const kinds = { 403: 'auth', 529: 'capacity' } as const

    expect(vendorFailureKind(403, kinds)).toBe('auth')
    expect(vendorFailureKind(529, kinds)).toBe('capacity')
    expect(vendorFailureKind(401, kinds)).toBe('auth')
    expect(vendorFailureKind(401, { 401: 'refused' })).toBe('refused')
    expect(vendorFailureKind(undefined, { 401: 'refused' })).toBe('unreachable')
  })
})

describe('createVendorApi send', () => {
  it('resolves a path against a base URL with or without a trailing slash', async () => {
    const fake = await start({ 'GET /api/session': () => ({ status: 200, json: { ok: true } }) })

    for (const baseUrl of [`${fake.url}/api`, `${fake.url}/api/`]) {
      const api = createVendorApi({ vendor: 'Acme', baseUrl })
      const response = await api.send('GET', 'session')
      expect(response.status).toBe(200)
    }

    expect(fake.routeCalls('GET /api/session')).toHaveLength(2)
  })

  it('sends per-call headers and the body, with fixed headers winning over a per-call header of the same name', async () => {
    const fake = await start({ 'POST /api/session': () => ({ status: 201, json: {} }) })
    const api = createVendorApi({
      vendor: 'Acme',
      baseUrl: `${fake.url}/api`,
      headers: { authorization: 'Bearer k-1' },
    })

    await api.send('POST', 'session', {
      headers: {
        'content-type': 'application/json',
        Authorization: 'Bearer from-the-call',
        'x-call': 'c-1',
      },
      body: JSON.stringify({ region: 'eu' }),
    })

    const [request] = fake.routeCalls('POST /api/session')
    expect(request?.headers).toMatchObject({
      authorization: 'Bearer k-1',
      'content-type': 'application/json',
      'x-call': 'c-1',
    })
    expect(request?.body).toEqual({ region: 'eu' })
  })

  it('refuses a credential header a header cannot carry on one line that leaves the value out', async () => {
    const fake = await start({ 'GET /session': () => ({ status: 200, json: {} }) })
    const api = createVendorApi({
      vendor: 'Acme',
      baseUrl: fake.url,
      headers: { authorization: 'Bearer k-secret-1\nk-secret-2' },
    })

    const failure = await api.send('GET', 'session').then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(PluginError)
    const error = failure as PluginError
    expect(error.message).toBe('Acme credentials hold a character a header cannot carry.')
    expect(error.kind).toBe('auth')
    expect(fake.routeCalls('GET /session')).toEqual([])
  })

  it('fails unreachable naming only the origin when nothing answers', async () => {
    const fake = await startLoopbackFake({ routes: {} })
    await fake.close()
    const api = createVendorApi({
      vendor: 'Acme',
      baseUrl: `${fake.url}/api`,
      headers: { authorization: 'Bearer k-secret-1' },
    })

    const failure = await api.send('GET', 'session').then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(PluginError)
    const error = failure as PluginError
    expect(error.kind).toBe('unreachable')
    expect(error.message.startsWith('Acme could not be reached at http://127.0.0.1:')).toBe(true)
    expect(error.message).not.toContain('k-secret-1')
    expect(error.message).not.toContain('/api')
    expect(error.message).not.toContain('\n')
  })

  it('rethrows the abort of an aborted call instead of a plugin failure', async () => {
    const fake = await start({ 'POST /things': ['hold'] })
    const api = createVendorApi({ vendor: 'Acme', baseUrl: fake.url })
    const controller = new AbortController()
    controller.abort()

    const failure = await api.send('POST', 'things', { signal: controller.signal }).then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(failure).not.toBeInstanceOf(PluginError)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).name).toBe('AbortError')
  })
})

describe('createVendorApi failure', () => {
  it("names the vendor, status, request and the body's message on one line", async () => {
    const error = await failureOf({ status: 409, json: { message: '  slot\n  taken ' } })

    expect(error).toBeInstanceOf(PluginError)
    expect(error.message).toBe('Acme answered 409 to POST /things: slot taken')
    expect(error.kind).toBe('refused')
  })

  it("reads the body's error when it has no message", async () => {
    const error = await failureOf({ status: 400, json: { error: 'bad' } })

    expect(error.message).toBe('Acme answered 400 to POST /things: bad')
  })

  it('gives no reason for a body that is not JSON', async () => {
    const fake = await start({ 'GET /x': [{ status: 500, text: 'upstream fell over' }] })
    const api = createVendorApi({ vendor: 'Acme', baseUrl: fake.url })

    const error = await api.failure(await api.send('GET', 'x'), 'GET /x')

    expect(error.message).toBe('Acme answered 500 to GET /x')
  })

  it('cuts a long reason to 200 characters', async () => {
    const error = await failureOf({ status: 400, json: { message: 'x'.repeat(300) } })

    expect(error.message).toBe(`Acme answered 400 to POST /things: ${'x'.repeat(200)}…`)
  })

  it('names the Retry-After wait on a 429 and reads it as capacity', async () => {
    const error = await failureOf({
      status: 429,
      json: { message: 'slow down' },
      headers: { 'retry-after': '7' },
    })

    expect(error.message).toBe('Acme answered 429 to POST /things: slow down, retry after 7 s')
    expect(error.kind).toBe('capacity')
  })

  it('names a Retry-After date as it was sent, without seconds', async () => {
    const error = await failureOf({
      status: 429,
      json: { message: 'slow down' },
      headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' },
    })

    expect(error.message).toBe(
      'Acme answered 429 to POST /things: slow down, retry after Wed, 21 Oct 2026 07:28:00 GMT',
    )
  })

  it('names no wait for a status other than 429', async () => {
    const error = await failureOf({ status: 529, json: {}, headers: { 'retry-after': '7' } })

    expect(error.message).toBe('Acme answered 529 to POST /things')
    expect(error.kind).toBe('refused')
  })

  it("takes the kind from the client's kinds", async () => {
    const error = await failureOf(
      { status: 529, json: { message: 'overloaded' } },
      { kinds: { 529: 'capacity' } },
    )

    expect(error.kind).toBe('capacity')
  })

  it('carries a handle when one is given', async () => {
    const fake = await start({ 'DELETE /things/:id': [{ status: 500, json: {} }] })
    const api = createVendorApi({ vendor: 'Acme', baseUrl: fake.url })

    const error = await api.failure(await api.send('DELETE', 'things/h1'), 'DELETE /things/{id}', {
      handle: { id: 'h1' },
    })

    expect(error.handle).toEqual({ id: 'h1' })
    expect(error.message).toBe('Acme answered 500 to DELETE /things/{id}')
  })
})

describe('createVendorApi json', () => {
  it('parses a JSON body and gives undefined for a body that is not JSON', async () => {
    const fake = await start({
      'GET /json': [{ status: 200, json: { id: 'b-1' } }],
      'GET /text': [{ status: 200, text: 'not json' }],
    })
    const api = createVendorApi({ vendor: 'Acme', baseUrl: fake.url })

    expect(await api.json(await api.send('GET', 'json'))).toEqual({ id: 'b-1' })
    expect(await api.json(await api.send('GET', 'text'))).toBeUndefined()
  })
})

describe('checkEndpoints', () => {
  it('accepts https anywhere and plain http only to this machine', () => {
    for (const endpoint of [
      'https://api.example.com',
      'http://127.0.0.1:9',
      'http://localhost:9',
      'http://[::1]:9',
    ]) {
      expect(() =>
        checkEndpoints({ endpoint }, [{ path: 'endpoint', scheme: 'https' }]),
      ).not.toThrow()
    }
  })

  it('accepts wss anywhere and plain ws only to this machine for a wss option', () => {
    for (const socket of ['wss://x.example.com', 'ws://127.0.0.1:9']) {
      expect(() => checkEndpoints({ socket }, [{ path: 'socket', scheme: 'wss' }])).not.toThrow()
    }
  })

  it('refuses plain http to another host, a user or password, and the wrong scheme', () => {
    const cases = [
      { value: 'http://api.example.com', scheme: 'https' as const },
      { value: 'https://user:secret@api.example.com', scheme: 'https' as const },
      { value: 'https://x.example.com', scheme: 'wss' as const },
    ]

    for (const { value, scheme } of cases) {
      const error = refusalOf(() =>
        checkEndpoints({ endpoint: value }, [{ path: 'endpoint', scheme }]),
      )
      expect(error.kind).toBe('refused')
      expect(error.path).toBe('endpoint')
      expect(error.message).toBe(
        `endpoint must use ${scheme}:// with no user or password, unless it points at this machine.`,
      )
    }
  })

  it('skips an option that is not set', () => {
    expect(() =>
      checkEndpoints({ endpoint: undefined }, [{ path: 'endpoint', scheme: 'https' }]),
    ).not.toThrow()
  })

  it('names the first refused option when two are refused', () => {
    const error = refusalOf(() =>
      checkEndpoints({ apiUrl: 'http://api.example.com', socketUrl: 'ws://x.example.com' }, [
        { path: 'apiUrl', scheme: 'https' },
        { path: 'socketUrl', scheme: 'wss' },
      ]),
    )

    expect(error.path).toBe('apiUrl')
    expect(error.message).toBe(
      'apiUrl must use https:// with no user or password, unless it points at this machine.',
    )
  })
})
