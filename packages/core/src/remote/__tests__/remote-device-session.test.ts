import type { RemoteDeviceConfig } from '@vostride/agent-qa-runner'
import { describe, expect, it } from 'vitest'

import {
  anyRemoteDevice,
  classifyCommandFailure,
  classifyNewSessionFailure,
  createRemoteDeviceRequestBounds,
  deviceDebugLoggingRefusal,
  iosDeviceTypeFromInfo,
  isUnknownCommandError,
  REMOTE_COMMAND_BOUND_MS,
  remoteDeviceLabel,
  remoteDeviceLostSentence,
  remoteDeviceRefusalKey,
  remoteDeviceRefusalSentence,
  scrubDeviceEndpoint,
  serverReasonLine,
  webdriverLogLevel,
} from '../remote-device-session.js'

const LABEL = 'farm (appium https://farm.example.com:443)'
const SECRET = 'farm-token-value'

function farm(extra: Partial<RemoteDeviceConfig> = {}): RemoteDeviceConfig {
  return {
    name: 'farm',
    protocol: 'appium',
    url: 'https://farm.example.com/wd/hub',
    connectTimeoutMs: 300_000,
    ...extra,
  }
}

function context(extra: { reason?: string; secretNames?: string[]; secretsFile?: string } = {}) {
  return {
    remote: farm(),
    device: 'galaxy-farm',
    secretsFile: '.env.secrets.local',
    secretNames: ['FARM_USER', 'FARM_KEY'],
    ...extra,
  }
}

const mask = (text: string): string => text.split(SECRET).join('[secret:FARM_KEY]')

function webdriverError(text: string, url = 'https://farm.example.com/wd/hub/session'): Error {
  return new Error(`WebDriverError: ${text} when running "${url}" with method "POST"`)
}

function unparsable(body: string): Error {
  return webdriverError(`Could not parse response body: "${body}"`)
}

function reply(statusCode: number, message = 'refused'): { statusCode: number; body: unknown } {
  return { statusCode, body: { value: { error: 'session not created', message } } }
}

describe('remoteDeviceLabel', () => {
  it('names the remote by name, protocol and origin, never its path', () => {
    expect(remoteDeviceLabel(farm({ url: 'https://farm.example.com/wd/hub?token=x' }))).toBe(LABEL)
  })
})

describe('classifyNewSessionFailure', () => {
  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [429, 'capacity'],
    [503, 'capacity'],
    [500, 'refused'],
    [404, 'refused'],
    [400, 'refused'],
  ] as const)('a %i reply is %s', (status, kind) => {
    expect(classifyNewSessionFailure(reply(status), webdriverError('refused'))).toBe(kind)
  })

  it('a request that timed out with no reply is timeout', () => {
    const error = new Error(
      'Request timed out! Consider increasing the "connectionRetryTimeout" option.',
    )
    expect(classifyNewSessionFailure(undefined, error)).toBe('timeout')
  })

  it('a reply that is not W3C JSON is refused', () => {
    expect(classifyNewSessionFailure(undefined, unparsable('<h1>Unauthorized</h1>'))).toBe(
      'refused',
    )
  })

  it.each([
    'Failed to fetch [POST] http://127.0.0.1:1/wd/hub/session: please make sure the server runs',
    'Request failed with error code ENOTFOUND',
    'Request failed with error code ECONNRESET',
    'Request failed with error code ERR_SSL_WRONG_VERSION_NUMBER',
  ])('no reply and "%s" is unreachable', (message) => {
    expect(classifyNewSessionFailure(undefined, new Error(message))).toBe('unreachable')
  })
})

describe('remoteDeviceRefusalSentence', () => {
  it('names the secrets to check when the credentials are refused', () => {
    expect(remoteDeviceRefusalSentence('auth', context())).toBe(
      `Remote ${LABEL} refused the credentials for device galaxy-farm. Check FARM_USER and FARM_KEY in .env.secrets.local.`,
    )
  })

  it('points at the remote entry when it references no secrets, and at workspace.secretsFile when none is set', () => {
    expect(remoteDeviceRefusalSentence('auth', context({ secretNames: [] }))).toBe(
      `Remote ${LABEL} refused the credentials for device galaxy-farm. Check its headers and basicAuth in registry.remotes.`,
    )
    expect(
      remoteDeviceRefusalSentence('auth', {
        ...context(),
        secretsFile: undefined,
        secretNames: ['FARM_KEY'],
      }),
    ).toBe(
      `Remote ${LABEL} refused the credentials for device galaxy-farm. Check FARM_KEY in workspace.secretsFile.`,
    )
  })

  it("follows a refused session with the server's reason", () => {
    expect(
      remoteDeviceRefusalSentence(
        'refused',
        context({ reason: 'no device matches appium:deviceName "Samsung Galaxy S25"' }),
      ),
    ).toBe(
      `Remote ${LABEL} refused a session for device galaxy-farm: no device matches appium:deviceName "Samsung Galaxy S25".`,
    )
  })

  it('ends a refused session at the device when the server gave no reason', () => {
    expect(remoteDeviceRefusalSentence('refused', context())).toBe(
      `Remote ${LABEL} refused a session for device galaxy-farm.`,
    )
  })

  it('names the connect timeout when no session opened in time', () => {
    expect(remoteDeviceRefusalSentence('timeout', context())).toBe(
      `Remote ${LABEL} did not open a session for device galaxy-farm within 5m. Raise its connectTimeout or check the service.`,
    )
    expect(
      remoteDeviceRefusalSentence('timeout', {
        ...context(),
        remote: farm({ connectTimeoutMs: 90_000 }),
      }),
    ).toContain('within 90s.')
  })

  it('says the remote has no free device, and that it did not answer', () => {
    expect(remoteDeviceRefusalSentence('capacity', context())).toBe(
      `Remote ${LABEL} has no free device for galaxy-farm. Lower use.workers or raise the service's limit.`,
    )
    expect(remoteDeviceRefusalSentence('unreachable', context())).toBe(
      `Remote ${LABEL} did not answer for device galaxy-farm. Check its url and that the server is running.`,
    )
  })
})

describe('serverReasonLine', () => {
  it("keeps only the first line of a JSON reply's message", () => {
    const received = reply(500, 'An unknown server-side error occurred.\n    at stack line one\n')
    expect(serverReasonLine({ reply: received }, mask)).toBe(
      'An unknown server-side error occurred.',
    )
  })

  it('reads the body of a reply that is not JSON, without its tags', () => {
    const error = unparsable('<html>\n<body><h1>401 Authorization Required</h1></body>\n</html>')
    expect(serverReasonLine({ error }, mask)).toBe('401 Authorization Required')
  })

  it('shows every url by its origin and masks declared secrets', () => {
    const received = reply(
      500,
      `token ${SECRET} rejected by https://farm.example.com/wd/hub/session?key=${SECRET}.`,
    )
    expect(serverReasonLine({ reply: received }, mask)).toBe(
      'token [secret:FARM_KEY] rejected by https://farm.example.com:443.',
    )
  })

  it('cuts a long reason short', () => {
    const line = serverReasonLine({ reply: reply(500, 'x'.repeat(500)) }, mask)
    expect(line).toHaveLength(200)
    expect(line?.endsWith('…')).toBe(true)
  })

  it('gives nothing when the server said nothing readable', () => {
    expect(serverReasonLine({ reply: { statusCode: 500, body: 'plain' } }, mask)).toBeUndefined()
    expect(serverReasonLine({ error: new Error('Request timed out!') }, mask)).toBeUndefined()
  })
})

describe('scrubDeviceEndpoint', () => {
  it("replaces WebdriverIO's request url with the remote's label", () => {
    const message =
      'WebDriverError: no such element when running "https://farm.example.com/wd/hub/session/Abc-XYZ_1/url?token=x" with method "GET"'
    const scrubbed = scrubDeviceEndpoint(message, farm())
    expect(scrubbed).toBe(
      `WebDriverError: no such element when running "${LABEL}" with method "GET"`,
    )
    expect(scrubbed).toContain('https://farm.example.com:443')
    expect(scrubbed).not.toMatch(/wd\/hub|Abc-XYZ_1|token/)
  })

  it("replaces the remote's own url, path and query included, and shows other urls by origin", () => {
    const remote = farm({ url: 'https://farm.example.com/wd/hub?token={{secret:FARM_KEY}}' })
    const text = `${remote.url} failed; see https://status.example.com/incidents/42?id=7.`
    expect(scrubDeviceEndpoint(text, remote)).toBe(
      `${LABEL} failed; see https://status.example.com:443.`,
    )
  })

  it('leaves the label itself as it is', () => {
    expect(scrubDeviceEndpoint(`Remote ${LABEL} ended.`, farm())).toBe(`Remote ${LABEL} ended.`)
  })
})

describe('createRemoteDeviceRequestBounds', () => {
  it('keeps the first reply before the session opens only', () => {
    const bounds = createRemoteDeviceRequestBounds({ connectTimeoutMs: 50, commandBoundMs: 50 })
    bounds.captureReply(reply(401))
    bounds.captureReply(reply(500))
    expect(bounds.newSessionReply()?.statusCode).toBe(401)

    bounds.markOpened()
    bounds.captureReply(reply(404))
    expect(bounds.newSessionReply()?.statusCode).toBe(401)
  })

  it('aborts the new session once the connect timeout passes', async () => {
    const bounds = createRemoteDeviceRequestBounds({ connectTimeoutMs: 50, commandBoundMs: 60_000 })
    const started = Date.now()
    const signal = bounds.boundRequest<{ signal?: AbortSignal }>({}).signal
    expect(signal?.aborted).toBe(false)
    await new Promise<void>((aborted) => signal?.addEventListener('abort', () => aborted()))
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('aborts a request after the session opens once the command bound passes', async () => {
    const bounds = createRemoteDeviceRequestBounds({ connectTimeoutMs: 60_000, commandBoundMs: 50 })
    bounds.markOpened()
    const signal = bounds.boundRequest<{ signal?: AbortSignal }>({}).signal
    expect(signal?.aborted).toBe(false)
    await new Promise<void>((aborted) => signal?.addEventListener('abort', () => aborted()))
    expect(signal?.aborted).toBe(true)
  })

  it("keeps a request's own signal alongside the bound", () => {
    const bounds = createRemoteDeviceRequestBounds({
      connectTimeoutMs: 300_000,
      commandBoundMs: REMOTE_COMMAND_BOUND_MS,
    })
    bounds.markOpened()
    const own = new AbortController()
    const signal = bounds.boundRequest({ signal: own.signal }).signal
    expect(signal?.aborted).toBe(false)
    own.abort()
    expect(signal?.aborted).toBe(true)
  })

  it("gives WebdriverIO's own request timeout the larger of the two bounds", () => {
    const short = { connectTimeoutMs: 30_000, commandBoundMs: REMOTE_COMMAND_BOUND_MS }
    expect(createRemoteDeviceRequestBounds(short).clientTimeoutMs).toBe(REMOTE_COMMAND_BOUND_MS)
    const long = { connectTimeoutMs: 300_000, commandBoundMs: REMOTE_COMMAND_BOUND_MS }
    expect(createRemoteDeviceRequestBounds(long).clientTimeoutMs).toBe(300_000)
  })

  it('bounds every later command at two minutes', () => {
    expect(REMOTE_COMMAND_BOUND_MS).toBe(120_000)
  })
})

describe('commands after the session opens', () => {
  it.each([
    [
      new Error('Request timed out! Consider increasing the "connectionRetryTimeout" option.'),
      'lost',
    ],
    [new Error('Request failed with error code ECONNRESET'), 'lost'],
    [new Error('Failed to fetch [GET] https://farm.example.com/wd/hub/session/a/source'), 'lost'],
    [Object.assign(new Error('session gone'), { name: 'invalid session id' }), 'ended'],
    [new Error('A session is either terminated or not started'), 'ended'],
    [Object.assign(new Error('no such element'), { name: 'no such element' }), undefined],
  ] as const)('%s is %s', (error, kind) => {
    expect(classifyCommandFailure(error)).toBe(kind)
  })

  it('names the command bound, a lost connection or an ended session', () => {
    const timedOut = new Error('Request timed out!')
    expect(
      remoteDeviceLostSentence('lost', { remote: farm(), device: 'galaxy-farm', error: timedOut }),
    ).toBe(`Remote ${LABEL} did not answer a command for device galaxy-farm within 2m.`)
    expect(remoteDeviceLostSentence('lost', { remote: farm(), device: 'galaxy-farm' })).toBe(
      `The connection to remote ${LABEL} was lost while device galaxy-farm ran this test.`,
    )
    expect(remoteDeviceLostSentence('ended', { remote: farm(), device: 'galaxy-farm' })).toBe(
      `Remote ${LABEL} ended the session for device galaxy-farm while this test ran.`,
    )
  })
})

describe('debug logging', () => {
  const device = { remote: farm(), device: 'galaxy-farm' }

  it("refuses WebdriverIO's own logging at any level but silent", () => {
    expect(deviceDebugLoggingRefusal({ WDIO_LOG_LEVEL: 'info' }, device)).toBe(
      "WDIO_LOG_LEVEL turns on WebdriverIO's own logging, which would print remote farm's address and requests. Unset WDIO_LOG_LEVEL to run device galaxy-farm.",
    )
    expect(deviceDebugLoggingRefusal({ WDIO_LOG_LEVEL: 'silent' }, device)).toBeUndefined()
    expect(deviceDebugLoggingRefusal({ WDIO_LOG_LEVEL: '' }, device)).toBeUndefined()
  })

  it.each(['undici', 'http,UNDICI', 'und*', '*'])('refuses NODE_DEBUG=%s', (value) => {
    expect(deviceDebugLoggingRefusal({ NODE_DEBUG: value }, device)).toBe(
      "NODE_DEBUG names undici, which prints remote farm's request paths. Remove undici and fetch from NODE_DEBUG to run device galaxy-farm.",
    )
  })

  it('names fetch when NODE_DEBUG names it alone', () => {
    expect(deviceDebugLoggingRefusal({ NODE_DEBUG: 'net, fetch' }, device)).toContain(
      'NODE_DEBUG names fetch,',
    )
  })

  it('lets other NODE_DEBUG names and an empty environment through', () => {
    expect(deviceDebugLoggingRefusal({ NODE_DEBUG: 'http,net,tls' }, device)).toBeUndefined()
    expect(deviceDebugLoggingRefusal({}, device)).toBeUndefined()
  })

  it('logs verbosely only when asked and no configured device has a remote', () => {
    expect(webdriverLogLevel({ verbose: true, anyRemoteDevice: false })).toBe('info')
    expect(webdriverLogLevel({ verbose: true, anyRemoteDevice: true })).toBe('silent')
    expect(webdriverLogLevel({ verbose: false, anyRemoteDevice: false })).toBe('silent')
  })

  it('finds a remote on any configured device', () => {
    expect(anyRemoteDevice({})).toBe(false)
    expect(anyRemoteDevice({ registry: { devices: { pixel: {} } } })).toBe(false)
    expect(
      anyRemoteDevice({ registry: { devices: { pixel: {}, 'galaxy-farm': { remote: 'farm' } } } }),
    ).toBe(true)
  })
})

describe('iOS device type and refused commands', () => {
  it.each([
    [{ isSimulator: true }, 'simulator'],
    [{ isSimulator: false }, 'real device'],
    [{ lockdownInfo: { DeviceClass: 'iPhone' } }, 'real device'],
    [{ name: 'iPhone' }, 'unknown'],
    [null, 'unknown'],
  ] as const)('device info %j reads as %s', (info, type) => {
    expect(iosDeviceTypeFromInfo(info)).toBe(type)
  })

  it('knows an unknown command or method by its name', () => {
    expect(isUnknownCommandError(Object.assign(new Error('x'), { name: 'unknown command' }))).toBe(
      true,
    )
    expect(isUnknownCommandError(Object.assign(new Error('x'), { name: 'unknown method' }))).toBe(
      true,
    )
    expect(isUnknownCommandError(new Error('unknown command'))).toBe(false)
  })

  it('remembers a refused session per device and every other refusal per remote', () => {
    expect(remoteDeviceRefusalKey(farm(), 'galaxy-farm', 'refused')).toBe('farm/galaxy-farm')
    expect(remoteDeviceRefusalKey(farm(), 'galaxy-farm', 'auth')).toBe('farm')
    expect(remoteDeviceRefusalKey(farm(), 'galaxy-farm', 'unreachable')).toBe('farm')
  })
})
