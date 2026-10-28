// The dashboard's one same-site predicate. The API router head, the run service router head and the
// live-editor socket call `refuseCrossSiteRequest`; the page arms and the frame socket call
// `refuseNonLoopbackHost`.

import type { IncomingMessage } from 'node:http'
import { isLoopbackHost } from '@vostride/agent-qa-core'

export const NON_LOOPBACK_HOST_REFUSAL =
  'Cross-site request refused: Host must name a loopback interface this server agreed to answer to.'

/**
 * Parse the authority from an HTTP Host header without treating the value as trustworthy.
 *
 * Brackets are required around an IPv6 literal because an unbracketed second colon is ambiguous
 * with the optional port. Anything outside the complete authority shape is deliberately invalid.
 */
export function hostnameOfHostHeader(hostHeader: string | undefined): string {
  if (hostHeader === undefined) return ''
  const normalized = hostHeader.trim().toLowerCase()
  const parsed = /^(?:\[([0-9a-f:.]*:[0-9a-f:.]*)\]|([a-z0-9.]+))(?::\d+)?$/u.exec(normalized)
  return parsed?.[1] ?? parsed?.[2] ?? ''
}

/**
 * Refuse a claimed Host this loopback-only server never agreed to answer to.
 *
 * An absent Host is refused rather than falling through: a name that was not stated cannot be
 * validated. The compatibility cost is limited to an HTTP/1.0 client that omits Host; HTTP/1.1
 * clients and browsers state it.
 */
export function refuseNonLoopbackHost(req: IncomingMessage): string | undefined {
  return isLoopbackHost(hostnameOfHostHeader(req.headers.host))
    ? undefined
    : NON_LOOPBACK_HOST_REFUSAL
}

/**
 * Refuse a request that a page on another origin drove. Three rules:
 *
 * - The Host must name a loopback interface.
 * - An `Origin`, when present, must name the request's own Host. The literal `null` is refused.
 * - `Sec-Fetch-Site`, when sent, must be `same-origin` or `none`.
 *
 * An absent `Origin` is admitted: browsers send one on every cross-origin write, so its absence
 * marks a local client (the CLI, `curl`, a script). Hosts are compared and schemes are not, so
 * the check holds behind an `https` terminator.
 */
export function refuseCrossSiteRequest(req: IncomingMessage): string | undefined {
  const hostRefusal = refuseNonLoopbackHost(req)
  if (hostRefusal !== undefined) return hostRefusal

  const refusal = 'Cross-site request refused: this door is driven from its own origin or from a '
    + 'local client that sends no Origin'
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '') {
    const host = typeof req.headers.host === 'string' ? req.headers.host.toLowerCase() : ''
    let originHost: string
    try {
      originHost = new URL(origin).host.toLowerCase()
    } catch {
      // Includes the literal `null`, which parses as no URL at all — a sandboxed frame, a
      // `data:` document, or a cross-origin redirect. Refused with everything else.
      return refusal
    }
    if (originHost === '' || host === '' || originHost !== host) return refusal
  }

  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return refusal

  return undefined
}
