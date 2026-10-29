// One guarded request-URL parse for the listener, the `upgrade` handler and the router head.

import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * The request URL, or `undefined` when the request line is not one.
 *
 * THE ONE PRODUCER. Its whole contract is that it never throws, which is what lets each caller
 * answer in its own vocabulary — a 400 body, a JSON envelope, a destroyed socket — instead of
 * every frame growing its own `try`.
 */
export function tryParseRequestUrl(req: Pick<IncomingMessage, 'url'>): URL | undefined {
  try {
    return new URL(req.url ?? '/', 'http://localhost')
  } catch {
    return undefined
  }
}

/**
 * Refuse a request whose target could not be parsed, in FIXED BYTES.
 *
 * NOTHING FROM THE REQUEST REACHES THIS RESPONSE, and that is deliberate rather than terse. The
 * refusal exists precisely because the request target is malformed and attacker-chosen; echoing it
 * would put attacker bytes into a body, and formatting it would give the refusal its own way to
 * throw. The previous round recorded the same lesson one layer down: a backstop that answers
 * through the door's own responder can re-enter the fault it was catching.
 */
export function refuseUnparseableRequest(res: ServerResponse): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  const body = 'Bad Request'
  res.writeHead(400, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Nothing from the request reaches this answer; the body is composed only from the bound port. */
export function refuseForeignHostPage(res: ServerResponse, port: number): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  const p = String(port)
  const body =
    'The agent-qa dashboard answers only at localhost, 127.0.0.1 or [::1].\n'
    + `Open http://localhost:${p}/ on the machine it runs on, or forward the port with `
    + `ssh -L ${p}:localhost:${p} <host>.\n`
  res.writeHead(403, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

// Only the error's constructor name and the method are logged; an error's serialization can leak.
export function backstopServerError(
  res: ServerResponse,
  req: Pick<IncomingMessage, 'method'>,
  error: unknown,
): void {
  const kind = error instanceof Error ? error.constructor.name : typeof error
  console.error(
    `Dashboard: a ${req.method ?? 'request'} handler threw (${kind}); answered 500 rather than `
    + 'ending the process',
  )
  if (res.headersSent) {
    res.destroy()
    return
  }
  const body = 'Internal Server Error'
  res.writeHead(500, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}
