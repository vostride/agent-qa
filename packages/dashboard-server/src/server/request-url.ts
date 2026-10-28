// The frames that must answer a request without trusting a byte of it (Phase 400 plan 16, gap 7).
//
// WHY THIS IS ONE MODULE AND NOT THREE GUARDS. `server.ts`'s async request listener, `server.ts`'s
// `upgrade` handler and `routes.ts`'s router head each parsed the request URL with their own
// `new URL(req.url ?? '/', 'http://localhost')`. Three copies is three chances to add a fourth, and
// gap round 1 already paid for the door-enumeration shape once: a fix that guards the arms somebody
// remembered to name cannot be driven to zero by naming more of them. So there is ONE producer of
// "parse the request URL safely" and the three frames import it. A fourth frame added later gets the
// guard by importing the only parse there is.
//
// ---- THE THROW-PATH ENUMERATION -------------------------------------------------------------
//
// Every way a request can end this process, and which mechanism here owns it. EXTEND THIS LIST
// rather than re-deriving it; the reason the list is written down is that the previous round's plan
// text enumerated these sites in prose, guarded one of them, and shipped.
//
//  1. THE REQUEST-LINE PARSE, request listener. `GET //%` and `GET http://[` are request targets
//     `node:http` accepts and the WHATWG URL parser rejects (`//%` reads as protocol-relative with
//     host `%`; `http://[` is an unterminated IPv6 literal). The listener is `async`, so the throw
//     became an UNHANDLED REJECTION and Node ended the process. Owned by `tryParseRequestUrl` +
//     `refuseUnparseableRequest`, which answer 400.
//  2. THE REQUEST-LINE PARSE, `upgrade` handler. The same two request targets, arriving with
//     `Connection: Upgrade`. This handler is SYNCHRONOUS, so its throw is an uncaught EXCEPTION
//     rather than a rejection: the listener's backstop below cannot see it and neither can
//     `clientError`. Owned by `tryParseRequestUrl` alone, whose `undefined` the handler answers
//     with its existing `socket.destroy()` idiom. This is the one path where the guarded parse and
//     nothing else is what keeps the process alive.
//  3. THE ROUTER-HEAD PARSE. `routes.ts` parsed the identical URL a second time. Unreachable in
//     production once (1) answers first, and guarded anyway: the router is exported and mounted
//     directly by the conformance suite, so an unguarded copy there is a live throw on a real
//     mount. Owned by `tryParseRequestUrl` + a 400 through the router's own `json` helper.
//  4. SYNCHRONOUS THROWS OUT OF A ROUTE. `%` inside a PATH is lenient — `/api/suites/%` parses
//     fine — and then `decodeURIComponent` throws a `URIError` inside the route arm. There are
//     ~18 such decode sites and there is no useful sense in which the next one is knowable, which
//     is exactly why they are NOT guarded one by one. Owned by `backstopServerError`, the
//     try/catch around the whole listener body, which answers 500.
//  5. REJECTED PROMISES THE LISTENER AWAITS. Same owner as (4) — the listener is `async`, so its
//     `catch` covers what it awaits as well as what it throws.
//  6. BYTES NODE'S OWN PARSER REJECTS, before any handler runs. Owned by the `clientError`
//     listener installed in `server.ts`.
//
// NOT owned here: a rejection from a promise a route arm starts and never awaits (a bare `.then()`
// with no `.catch`). That is a real class, it is upstream of this plan's fence, and it is called
// out so the next author does not read this list as complete.

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

/**
 * The process-level backstop's answer: a 500 in fixed bytes, or a destroyed socket if it is late.
 *
 * THE ERROR IS NOT PRINTED AND NOT SERIALIZED. Phase 395 measured a planted credential leaving this
 * product through an error's serialization rather than its `message`, so what goes to stderr here
 * is the error's CONSTRUCTOR NAME and the request METHOD — two values with no attacker- or
 * secret-derived content — and never the URL, which is attacker-chosen, or the error itself, whose
 * `cause` chain is exactly the surface that leaked.
 */
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
