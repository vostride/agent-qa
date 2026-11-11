// Every request a report makes runs on sockets made here, under a deadline, so each one can be
// destroyed: through a proxy, the SDK's own agent holds a socket no caller can reach, and a silent
// proxy kept it open for good.

import { Agent as HttpAgent, request as httpRequest } from 'node:http'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import type { RequestOptions as HttpsRequestOptions } from 'node:https'
import { connect as netConnect, isIP, isIPv6 } from 'node:net'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { connect as tlsConnect } from 'node:tls'
import { urlToHttpOptions } from 'node:url'

import { DEFAULT_ANALYTICS_SHUTDOWN_TIMEOUT_MS } from '@vostride/agent-qa-analytics'

// The shape of the SDK transport's `httpModule` option.
export interface ReportRequestModule {
  request(
    options: HttpsRequestOptions | string | URL,
    onResponse?: (response: IncomingMessage) => void,
  ): ClientRequest
}

export interface ReportRequests extends ReportRequestModule {
  // Ends every request still open and destroys every socket it opened.
  abandon(): void
}

export interface ReportRequestOptions {
  readonly timeoutMs?: number
  readonly env?: NodeJS.ProcessEnv
}

interface ReportTarget {
  readonly host: string
  readonly port: number
  readonly secure: boolean
}

type ConnectionDone = (error: Error | null, socket?: Duplex) => void

const TUNNEL_OPENED = /^HTTP\/1\.[01] 200(?:\s|$)/u
const MOST_PROXY_HEAD_BYTES = 16_384

export function boundedRequestModule(
  protocol: string,
  options: ReportRequestOptions = {},
): ReportRequests {
  const secure = protocol === 'https:'
  const timeoutMs = options.timeoutMs ?? DEFAULT_ANALYTICS_SHUTDOWN_TIMEOUT_MS
  const env = options.env ?? process.env
  const agent = secure ? new HttpsAgent({ keepAlive: true }) : new HttpAgent({ keepAlive: true })
  const open = new Set<() => void>()
  return {
    request: (given, onResponse) => {
      const requestOptions: HttpsRequestOptions =
        typeof given === 'string' || given instanceof URL ? urlToHttpOptions(new URL(given)) : given
      const target = reportTarget(requestOptions, secure)
      const proxy = reportProxy(target, env)
      const sockets = new Set<Duplex>()
      const routed: HttpsRequestOptions =
        proxy === undefined
          ? { ...requestOptions, agent }
          : {
              ...requestOptions,
              agent: undefined,
              port: target.port,
              defaultPort: secure ? 443 : 80,
              createConnection: (_, oncreate) => {
                tunnel(proxy, target, requestOptions.ca, sockets, (error, socket) => {
                  oncreate(error, socket as Duplex)
                })
                return undefined
              },
            }
      const request = secure ? httpsRequest(routed, onResponse) : httpRequest(routed, onResponse)
      const end = () => {
        open.delete(end)
        clearTimeout(deadline)
        request.destroy(new Error('the report request ended before it was answered'))
        for (const socket of sockets) socket.destroy()
      }
      // Unref'd: it bounds the request without holding the process for it.
      const deadline = setTimeout(end, timeoutMs)
      deadline.unref()
      open.add(end)
      request.on('socket', (socket) => {
        sockets.add(socket)
        // A tunnel is handed over paused, so no answer is read before the request listens.
        socket.resume()
      })
      request.once('close', () => {
        open.delete(end)
        clearTimeout(deadline)
      })
      return request
    },
    abandon: () => {
      for (const end of [...open]) end()
    },
  }
}

function reportTarget(options: HttpsRequestOptions, secure: boolean): ReportTarget {
  const host = String(options.hostname ?? options.host ?? 'localhost').replace(/^\[|\]$/gu, '')
  return { host, port: Number(options.port) || (secure ? 443 : 80), secure }
}

// The SDK's own rule: https_proxy for an https: DSN, then http_proxy, unless an entry of no_proxy
// ends the ingest's host. An empty entry exempts nothing.
function reportProxy(target: ReportTarget, env: NodeJS.ProcessEnv): URL | undefined {
  const named = (target.secure ? env.https_proxy : undefined) || env.http_proxy
  if (named === undefined || named === '') return undefined
  const authority = `${target.host}:${String(target.port)}`
  const exempt = (env.no_proxy ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .some((entry) => entry !== '' && (authority.endsWith(entry) || target.host.endsWith(entry)))
  return exempt ? undefined : (URL.parse(named) ?? undefined)
}

function serverName(host: string): { servername?: string } {
  return isIP(host) === 0 ? { servername: host } : {}
}

// One CONNECT through the proxy. Every socket it opens joins `sockets` first, so the request's
// deadline reaches it while the proxy has not answered.
function tunnel(
  proxy: URL,
  target: ReportTarget,
  ca: HttpsRequestOptions['ca'],
  sockets: Set<Duplex>,
  done: ConnectionDone,
): void {
  const proxyHost = proxy.hostname.replace(/^\[|\]$/gu, '')
  const proxyPort = Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80)
  const raw: Socket =
    proxy.protocol === 'https:'
      ? tlsConnect({
          host: proxyHost,
          port: proxyPort,
          ALPNProtocols: ['http/1.1'],
          ...serverName(proxyHost),
        })
      : netConnect({ host: proxyHost, port: proxyPort })
  sockets.add(raw)
  let head = Buffer.alloc(0)
  let settled = false
  const settle: ConnectionDone = (error, socket) => {
    if (settled) return
    settled = true
    raw.off('data', read)
    if (error !== null) raw.destroy()
    done(error, socket)
  }
  const read = (chunk: Buffer) => {
    head = Buffer.concat([head, chunk])
    const end = head.indexOf('\r\n\r\n')
    if (end === -1) {
      if (head.length > MOST_PROXY_HEAD_BYTES) settle(new Error('the proxy sent no end of headers'))
      return
    }
    raw.pause()
    if (!TUNNEL_OPENED.test(head.toString('latin1', 0, end))) {
      settle(new Error('the proxy did not open a tunnel for the report'))
      return
    }
    if (end + 4 < head.length) raw.unshift(head.subarray(end + 4))
    if (!target.secure) {
      settle(null, raw)
      return
    }
    const secured = tlsConnect({
      socket: raw,
      ...serverName(target.host),
      ...(ca === undefined ? {} : { ca }),
    })
    secured.on('error', () => {})
    sockets.add(secured)
    settle(null, secured)
  }
  raw.on('data', read)
  raw.on('error', (error) => {
    settle(error)
  })
  raw.once('close', () => {
    settle(new Error('the proxy closed before it opened a tunnel for the report'))
  })
  raw.write(connectRequest(proxy, target))
}

function connectRequest(proxy: URL, target: ReportTarget): string {
  const host = isIPv6(target.host) ? `[${target.host}]` : target.host
  const authority = `${host}:${String(target.port)}`
  const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`]
  if (proxy.username !== '' || proxy.password !== '') {
    const user = decodeURIComponent(proxy.username)
    const password = decodeURIComponent(proxy.password)
    const credentials = Buffer.from(`${user}:${password}`).toString('base64')
    lines.push(`Proxy-Authorization: Basic ${credentials}`)
  }
  return `${lines.join('\r\n')}\r\n\r\n`
}
