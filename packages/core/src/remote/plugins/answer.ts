import { RemoteRefusalError, type RemoteProtocol } from '@vostride/agent-qa-runner'
import { formatRemoteOrigin, isLoopbackHost, remoteOrigin } from '@vostride/agent-qa-schema'

export interface PluginAnswerContext {
  serves: readonly string[]
  place: 'web' | 'device'
  // The browser a web session asked for; cdp drives Chromium only.
  engine?: string
  remote: string
  entry: string
}

const PLACE_PROTOCOLS: Record<PluginAnswerContext['place'], readonly RemoteProtocol[]> = {
  web: ['playwright', 'cdp'],
  device: ['appium'],
}

const PROTOCOL_SCHEMES: Record<RemoteProtocol, readonly string[]> = {
  playwright: ['ws', 'wss'],
  cdp: ['ws', 'wss', 'http', 'https'],
  appium: ['http', 'https'],
}

const CLEARTEXT_SCHEMES = new Set(['ws', 'http'])

function hasUserinfo(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.username !== '' || parsed.password !== ''
  } catch {
    return false
  }
}

// A credential query is a vendor's own business here; only what agent-qa connects over is judged.
export function checkPluginAnswer(
  answer: { protocol: RemoteProtocol; url: string },
  context: PluginAnswerContext,
): RemoteRefusalError | undefined {
  const { remote, entry } = context
  const refuse = (what: string) =>
    new RemoteRefusalError(`Remote ${remote}: plugin entry ${entry} answered with ${what}`, {
      remote,
      kind: 'refused',
    })

  if (
    !context.serves.includes(answer.protocol)
    || !PLACE_PROTOCOLS[context.place].includes(answer.protocol)
  ) {
    return refuse(`${answer.protocol}, which it does not serve for this test.`)
  }
  if (answer.protocol === 'cdp' && context.engine !== undefined && context.engine !== 'chromium') {
    return refuse(`cdp for a ${context.engine} test; cdp drives Chromium only.`)
  }

  const origin = remoteOrigin(answer.url)
  if (origin === undefined || !PROTOCOL_SCHEMES[answer.protocol].includes(origin.scheme)) {
    return refuse(`a url that a ${answer.protocol} connection cannot use.`)
  }
  if (hasUserinfo(answer.url)) {
    return refuse('a url that carries credentials; plugins send them in headers.')
  }
  if (CLEARTEXT_SCHEMES.has(origin.scheme) && !isLoopbackHost(origin.host)) {
    return refuse(`a cleartext url to ${formatRemoteOrigin(origin)}; use wss:// or https://.`)
  }
  return undefined
}
