import { describe, expect, it } from 'vitest'

import { checkPluginAnswer } from '../answer.js'

const web = { serves: ['playwright', 'cdp'], place: 'web', remote: 'lab-a', entry: 'lab' } as const

describe('checkPluginAnswer', () => {
  it('accepts a served protocol on a secure or loopback url', () => {
    const answers = [
      { protocol: 'playwright', url: 'wss://browsers.example.com/s' },
      { protocol: 'playwright', url: 'ws://127.0.0.1:9222/s' },
      { protocol: 'cdp', url: 'http://localhost:9222' },
    ] as const

    for (const answer of answers) expect(checkPluginAnswer(answer, web)).toBeUndefined()
  })

  it("accepts a vendor's credential in the query, which only a url remote is refused for", () => {
    expect(
      checkPluginAnswer(
        { protocol: 'playwright', url: 'wss://browsers.example.com/s?apiKey=abc' },
        web,
      ),
    ).toBeUndefined()
  })

  it('refuses appium for a web session', () => {
    const refused = checkPluginAnswer({ protocol: 'appium', url: 'https://hub.example.com' }, web)

    expect(refused?.message).toBe(
      'Remote lab-a: plugin entry lab answered with appium, which it does not serve for this test.',
    )
    expect(refused?.kind).toBe('refused')
    expect(refused?.remote).toBe('lab-a')
  })

  it('refuses cdp for a web session that asked for another engine than Chromium', () => {
    const firefox = { ...web, engine: 'firefox' }
    const refused = checkPluginAnswer({ protocol: 'cdp', url: 'wss://lab.example.com/s' }, firefox)

    expect(refused?.kind).toBe('refused')
    expect(refused?.message).toBe(
      'Remote lab-a: plugin entry lab answered with cdp for a firefox test; cdp drives Chromium '
        + 'only.',
    )
    const chromium = { ...web, engine: 'chromium' }
    expect(
      checkPluginAnswer({ protocol: 'cdp', url: 'wss://lab.example.com/s' }, chromium),
    ).toBeUndefined()
    expect(
      checkPluginAnswer({ protocol: 'playwright', url: 'wss://lab.example.com/s' }, firefox),
    ).toBeUndefined()
  })

  it('refuses a protocol the manifest does not serve', () => {
    const refused = checkPluginAnswer(
      { protocol: 'cdp', url: 'wss://browsers.example.com/s' },
      { ...web, serves: ['playwright'] },
    )

    expect(refused?.message).toBe(
      'Remote lab-a: plugin entry lab answered with cdp, which it does not serve for this test.',
    )
  })

  it('refuses a web protocol for a device session', () => {
    const refused = checkPluginAnswer(
      { protocol: 'playwright', url: 'wss://browsers.example.com/s' },
      { serves: ['playwright', 'appium'], place: 'device', remote: 'farm', entry: 'lab' },
    )

    expect(refused?.message).toBe(
      'Remote farm: plugin entry lab answered with playwright, which it does not serve for this test.',
    )
  })

  it('refuses a url that carries credentials', () => {
    const refused = checkPluginAnswer(
      { protocol: 'playwright', url: 'wss://user:password@browsers.example.com/s' },
      web,
    )

    expect(refused?.message).toBe(
      'Remote lab-a: plugin entry lab answered with a url that carries credentials; plugins send them in headers.',
    )
    expect(refused?.kind).toBe('refused')
  })

  it('refuses cleartext ws:// and http:// to a host that is not loopback', () => {
    const ws = checkPluginAnswer(
      { protocol: 'playwright', url: 'ws://browsers.example.com/s' },
      web,
    )
    const http = checkPluginAnswer({ protocol: 'cdp', url: 'http://10.0.0.5:9222' }, web)

    expect(ws?.message).toBe(
      'Remote lab-a: plugin entry lab answered with a cleartext url to ws://browsers.example.com:80; use wss:// or https://.',
    )
    expect(http?.message).toBe(
      'Remote lab-a: plugin entry lab answered with a cleartext url to http://10.0.0.5:9222; use wss:// or https://.',
    )
    expect(ws?.kind).toBe('refused')
  })

  it('refuses a url that is not one its protocol connects to', () => {
    expect(
      checkPluginAnswer({ protocol: 'playwright', url: 'https://browsers.example.com' }, web)
        ?.message,
    ).toBe(
      'Remote lab-a: plugin entry lab answered with a url that a playwright connection cannot use.',
    )
    expect(checkPluginAnswer({ protocol: 'playwright', url: 'not a url' }, web)?.message).toBe(
      'Remote lab-a: plugin entry lab answered with a url that a playwright connection cannot use.',
    )
  })
})
