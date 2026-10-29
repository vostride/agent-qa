// The surface roster: a pinned closed set.
//
// WHY A CLOSED SET AND NOT A DISCOVERY. "No private powers" is a claim about EVERY surface, and a
// suite that ranged over whatever surfaces it happened to find would be measuring an accident. Two
// surfaces exist today — the chat host and the MCP server — and they are named here as data so that
// adding a third is a reviewed one-line diff rather than a silent widening of the claim.
//
// FOUR ROWS. The sentence above is left as it was written because this file reads as a
// dated history, and its counts are history too; the roster itself is what states the current set.
//
// FOUR ROWS AGAIN. The dashboard chat door is deleted with its routes
// so its row and its adapter go with it; the counts above are left as written, and the
// roster below states the current set. `'dashboard'` stays a CALLER surface (run detail still reads
// and marks through the host); it is no longer a registry-driven door.
//
// THE REGISTRATION NOTE. A surface that lands after this date MUST arrive with a roster
// row and an adapter, in the same change that ships it. Three are already anticipated:
//
//   * 398's capability catalogue, if it enumerates capabilities to a caller rather than only
//     describing them;
//   * the M5 dashboard, whose HTTP path is the exact private channel the v1 server carried and the
//     one this whole suite exists to make impossible to re-create quietly;
//   * any post-v2.0 REST or SDK surface.
//
// A surface without a row is not "not yet covered" — it is a surface the parity claim silently
// excludes itself from, which is worse than an uncovered one because the suite still reads green.
//
// THE CAPABILITY CATALOGUE IS NOT A SURFACE. The first of the three
// anticipated arrivals above has landed, and the answer to its "if it enumerates" condition is NO
// ROW. A surface is an INVOCATION DOOR: dispatch, policy, and gate verdicts. The catalogue
// (`packages/cli/capability-catalog/capability-catalog.json`, produced by `catalog.ts`) invokes
// nothing — it is committed build-time data describing what exists — so legs 3 and 4 of every
// rostered surface would be vacuous for it, and a roster row whose policy legs assert nothing is
// exactly the skip-list 397 D-12 refuses to start keeping.
//
// WHAT ANSWERS THE ENUMERATION OBLIGATION INSTEAD. The condition the note above was really about is
// "can a capability be reached, or advertised, without this suite seeing it". For the catalogue
// that is answered by census rather than by dispatch: `catalog.test.ts` asserts its op rows against
// the committed golden ledger, its alias rows against the shipped resolver table, and its skill
// rows against the skills directory — each set-equal in BOTH directions. A capability the catalogue
// advertised and the registry did not declare is a named RED there, which is the same guarantee a
// roster row would have bought and the only one it could have.
//
// THIS CLOSES THE RESERVATION FOR THE CATALOGUE ONLY. The M5 dashboard and any post-v2.0 REST or
// SDK surface are unaffected: both dispatch, so both arrive with a row and an adapter. And if the
// catalogue ever grows a read ENDPOINT — a caller asking a running process what exists, rather than
// reading committed bytes — that endpoint is a door, and this note does not cover it.
//
// THE `fn` DOOR IS THE THIRD ROW. This is the registration note
// above being honoured rather than an exception to it: `agent-qa fn` is an INVOCATION DOOR by the
// 2026-08-17 test — it dispatches, it consults the gate, and a person reaches every registered
// capability through it — and it had no row for three phases. 399's UAT is what made the omission
// costly: `fn` is the door the owner called HONEST (399 D-14, the CLI parity door), the one whose
// render the chat surface's default was then re-derived from, and the suite could not compare the
// two because only one of them was rostered. A parity claim about "what a person sees" that ranges
// the two surfaces that DON'T print the payload, and not the one that does, is a claim measured
// against the wrong denominator.
//
// WHAT IS AND IS NOT ON THE ROW (397 D-03, unchanged). The row is the REGISTRY-DRIVEN `fn` path —
// `--list` and `fn <id>`, which own no capability of their own and resolve everything through
// `invokeFunction`. The bespoke per-capability CLI command handlers (`agent-qa run`, `knowledge
// rollback`, …; 2026-10-02, 432-40: `proposals show` left with the inbox in 432-17) stay OFF the
// roster exactly as 397 D-03 ruled: rostering them would mint a new parity
// claim over hand-written handlers this suite has never measured, which is a widening dressed as a
// completion. So D-04's rule reads unchanged for the third time: adding a surface adds a ROW and an
// ADAPTER, in the change that ships it.
//
// THE ROW NAMES ITS ADAPTER RATHER THAN INLINING ONE. What a surface IS (a member of the roster) and
// HOW it is read (a wire round trip, a projection walk) are different questions with different
// reasons to change, and the enumeration mechanics carry enough reasoning to want their own module.

import {
  chatSurfaceAdapter,
  fnSurfaceAdapter,
  mcpSurfaceAdapter,
  runServiceSurfaceAdapter,
  type SurfaceAdapter,
} from './adapters.js'

/** One rostered surface. */
export interface SurfaceRosterEntry {
  /** The suite's word for the surface — it appears in every named RED this suite raises. */
  readonly id: string
  readonly adapter: SurfaceAdapter
}

export const SURFACE_ROSTER: readonly SurfaceRosterEntry[] = Object.freeze([
  // The chat host (392). TWO routes behind one row, both enumerated by the adapter: the planner
  // binds every listed op 1:1 into the model's vocabulary, and the deterministic resolver dispatches
  // without a model at all. One row because they are one surface — a person typing at one prompt.
  Object.freeze({ id: 'chat', adapter: chatSurfaceAdapter }),
  // The MCP server (396). Twelve workflow-coarse tools over twenty-two ops via the declared mapping;
  // the adapter folds a live listing back into op ids rather than comparing wire names to wire
  // names, because the other surface has no wire names to compare against.
  Object.freeze({ id: 'mcp', adapter: mcpSurfaceAdapter }),
  // The `fn` door (384, rostered 399.1 D-07). One route and no projection at all: the id a person
  // types IS the registry id, so the adapter's fold from wire names to op ids — the move the two
  // rows above both need — is the identity here. What its adapter still has to do is DRIVE the
  // command rather than read the registry, because the listing passes through a composition root, a
  // caller mint and a declaration projection, and a set assembled from the registry this file could
  // reach would be the same set on both sides of every comparison.
  Object.freeze({ id: 'fn', adapter: fnSurfaceAdapter }),
  // The run service (402, rostered 402-07, D-04). THE THIRD OF THE THREE ARRIVALS the
  // 2026-08-16 registration note reserved — "any post-v2.0 REST or SDK surface" — and the first door
  // on this roster that is NARROW BY DESIGN. It dispatches, and a caller reaches it over TCP, so it
  // is an INVOCATION DOOR by the 2026-08-17 test and it arrives with a row in the phase that ships
  // it. (2026-10-01, 432-21 D-12: it asks for no bearer credential any more, and it consults no gate
  // since 432-13; loopback and its same-site guard bound who reaches it.)
  //
  // WHAT IS AND IS NOT ON THE ROW, on 397 D-03's unchanged rule. The row is the whole door: the
  // three paths `RUN_SERVICE_ROUTE_TABLE` publishes and no fourth. There is nothing to leave off,
  // which is the one respect in which this row is simpler than the four above — the dashboard's
  // ninety hand-written v1 routes are OFF the roster and stay off, and this door added none of them.
  //
  // THE NARROWNESS IS DECLARED RATHER THAN INFERRED. Every row above reaches the whole registry
  // census, so a row's reach was never a fact anyone had to state. This one reaches exactly
  // `runs.start` plus a stream, and its adapter carries a `notApplicable` enumeration saying which
  // capability classes the door structurally cannot serve and WHY — a property of the door a reader
  // can check against the route table, not a schedule. A narrow door whose narrowness showed up only
  // as ops it happened not to enumerate would be indistinguishable from a door that lost half its
  // reach in a regression, and that is the reading this roster exists to prevent.
  //
  // THE ADAPTER DRIVES THE PRODUCTION COMPOSITION over real TCP — `startServer` with the run service
  // mounted, which is what `agent-qa dashboard` assembles. Driving the door from OUTSIDE the process
  // entirely is a separate and stronger question, and it has its own file:
  // `run-service-anchors.test.ts` spawns the built binary and reads the same routes off a socket.
  Object.freeze({ id: 'run-service', adapter: runServiceSurfaceAdapter }),
] as const satisfies readonly SurfaceRosterEntry[])
