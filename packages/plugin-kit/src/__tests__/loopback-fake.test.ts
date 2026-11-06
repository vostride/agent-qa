import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { startLoopbackFake, type LoopbackFake } from '../testing/index.js'

const fakes: LoopbackFake[] = []

afterEach(async () => {
  await Promise.all(fakes.splice(0).map((fake) => fake.close()))
})

async function start(routes: Parameters<typeof startLoopbackFake>[0]['routes']) {
  const fake = await startLoopbackFake({ routes })
  fakes.push(fake)
  return fake
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

describe('startLoopbackFake', () => {
  it('serves scripted replies in order and repeats the last one past the end', async () => {
    const fake = await start({
      'POST /browsers': [
        { status: 503, json: { message: 'no capacity' } },
        { status: 201, json: { id: 'b-1' } },
      ],
    })

    const answers = []
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await post(`${fake.url}/browsers`, { attempt })
      answers.push({ status: response.status, body: await response.json() })
    }

    expect(answers).toEqual([
      { status: 503, body: { message: 'no capacity' } },
      { status: 201, body: { id: 'b-1' } },
      { status: 201, body: { id: 'b-1' } },
    ])
    expect(fake.routeCalls('POST /browsers').map((request) => request.body)).toEqual([
      { attempt: 0 },
      { attempt: 1 },
      { attempt: 2 },
    ])
  })

  it('records the method, path, headers and parsed JSON body of every request', async () => {
    const fake = await start({ 'POST /browsers': [{ status: 201, json: { id: 'b-1' } }] })

    await post(`${fake.url}/browsers?region=eu`, { engine: 'chromium' }, { 'X-Api-Key': 'k-1' })
    await fetch(`${fake.url}/missing`)

    expect(fake.requests).toHaveLength(2)
    expect(fake.requests[0]).toMatchObject({
      method: 'POST',
      path: '/browsers',
      query: { region: 'eu' },
      headers: { 'x-api-key': 'k-1', 'content-type': 'application/json' },
      body: { engine: 'chromium' },
    })
    expect(fake.requests[1]).toMatchObject({ method: 'GET', path: '/missing', body: undefined })
  })

  it('answers a route function with the request, :param segments included', async () => {
    const fake = await start({
      'DELETE /browsers/:id': (request) => ({
        status: 200,
        json: { deleted: request.params.id },
        headers: { 'x-request': request.path },
      }),
    })

    const response = await fetch(`${fake.url}/browsers/b-7`, { method: 'DELETE' })

    expect(response.status).toBe(200)
    expect(response.headers.get('x-request')).toBe('/browsers/b-7')
    expect(await response.json()).toEqual({ deleted: 'b-7' })
    expect(fake.routeCalls('DELETE /browsers/:id')).toHaveLength(1)
  })

  it('serves a text reply with its headers', async () => {
    const fake = await start({
      'GET /health': [{ status: 200, text: 'ok', headers: { 'x-vendor': 'acme' } }],
    })

    const response = await fetch(`${fake.url}/health`)

    expect(await response.text()).toBe('ok')
    expect(response.headers.get('x-vendor')).toBe('acme')
    expect(response.headers.get('content-type')).toContain('text/plain')
  })

  it('answers an unknown route 404 with no route', async () => {
    const fake = await start({ 'GET /health': [{ status: 200, text: 'ok' }] })

    const wrongMethod = await fetch(`${fake.url}/health`, { method: 'POST' })
    const wrongPath = await fetch(`${fake.url}/browsers/b-1/extra`)

    expect(wrongMethod.status).toBe(404)
    expect(await wrongMethod.json()).toEqual({ message: 'no route' })
    expect(wrongPath.status).toBe(404)
  })

  it('never answers a held reply until the fake closes', async () => {
    const fake = await start({ 'POST /browsers': ['hold'] })

    const pending = post(`${fake.url}/browsers`, {}).then(
      (response) => `answered ${response.status}`,
      () => 'closed',
    )
    const first = await Promise.race([pending, sleep(300).then(() => 'still waiting')])

    expect(first).toBe('still waiting')
    expect(fake.routeCalls('POST /browsers')).toHaveLength(1)
    await fake.close()
    expect(await pending).toBe('closed')
  })

  it('answers 500 when a route function throws, and rejects close with that error', async () => {
    const fake = await startLoopbackFake({
      routes: {
        'POST /browsers': () => {
          throw new Error('expected the bearer token')
        },
      },
    })

    const response = await post(`${fake.url}/browsers`, {})

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      message: 'the route threw: Error: expected the bearer token',
    })
    await expect(fake.close()).rejects.toThrow('expected the bearer token')
  })

  it('passes a :param segment that is not valid percent-encoding through as written', async () => {
    const fake = await start({ 'GET /browsers/:id': () => ({ status: 204 }) })

    const response = await fetch(`${fake.url}/browsers/50%zz`)

    expect(response.status).toBe(204)
    expect(fake.routeCalls('GET /browsers/:id')[0]?.params).toEqual({ id: '50%zz' })
  })

  it('listens on 127.0.0.1 only', async () => {
    const fake = await start({})

    expect(fake.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(new URL(fake.url).hostname).toBe('127.0.0.1')
    expect(fake.origin).toBe(fake.url)
  })
})
