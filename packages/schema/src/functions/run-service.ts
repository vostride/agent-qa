// The remote run service's wire vocabulary (Phase 402 plan 01, D-06 / D-13 / D-15 · INVK-03).
//
// WHAT LIVES HERE AND WHAT DELIBERATELY DOES NOT. This file holds the vocabulary the authed run
// service speaks on the wire: the closed error-code set every refusal answers with, the readiness
// DTO, the request shape, and the door's own contract version. 2026-10-01 (432-21, D-12): the
// bearer header verdict and its three refusal reasons are deleted with the run-service tokens. It holds no
// transport, no token, no route and no handler — the router that serves these words lives in
// `packages/dashboard-server` and the composition that mints them lives in the CLI, because a
// mountable module (D-02) can only be mountable if its vocabulary is reachable from a package
// neither of them owns.
//
// THE EVENT VOCABULARY IS NOT HERE EITHER, AND THAT ABSENCE IS THE POINT (D-13). The stream serves
// the frozen bus envelope verbatim — `RunEventEnvelopeSchema`, SSE `id` = `seq`, `event` = `type`.
// A projection DTO in this file would be a second event vocabulary to drift against the first.

import { z } from 'zod'

/**
 * The door's own contract version, bumped INDEPENDENTLY of the bus envelope's.
 *
 * Two versions because two contracts move for different reasons: `RUN_EVENT_ENVELOPE_SCHEMA_VERSION`
 * describes the frozen event frame, and this describes what routes exist and what they answer. 403
 * adds the attach contract to this door and will bump THIS constant without touching an envelope.
 *
 * 2026-10-02 (quick 261002-ctr): 2. Version 1 answered readiness with `authConfigured` and refused a
 * request with three bearer reasons; 432-21 deleted the bearer reasons (and added
 * `cross_site_refused`) and 432-22 deleted `authConfigured`. Both changed what these routes answer,
 * so the version moves once for the pair. The routes themselves, the start request and the stream
 * are unchanged.
 */
export const RUN_SERVICE_CONTRACT_VERSION = 2

// 2026-10-01 (432-21, D-12): `SERVICE_BEARER_REFUSAL_REASONS`, `ServiceBearerRefusalReason` and the
// two-arm `ServiceBearerVerdict` are deleted with `services.dashboard.runServiceTokens` and the door's
// `verifyBearer` port. The door reads no `Authorization` header; what refuses a request before the
// route table now is the dashboard's same-site guard (`cross_site_refused` below).

/**
 * Every code any non-2xx answer on this door carries. Closed, and shared across all routes.
 *
 * 2026-10-01 (432-21, D-12/D-13): the three bearer refusal reasons left with the bearer, and
 * `cross_site_refused` took their place above the route table. The door answers a request a page on
 * another origin drove — or one naming a Host this loopback server never agreed to answer to — with
 * that word and nothing else, the same word the dashboard's other same-site doors use.
 */
export const RUN_SERVICE_ERROR_CODES = [
  'cross_site_refused',
  'refused_request_field',
  'invalid_request_body',
  'unknown_run',
  'unknown_route',
  'run_start_failed',
  'replay_unavailable',
  // 402-04 (D-14, T-402-14): the `?handle=` parameter's two refusals, kept APART. `invalid_handle`
  // says the parameter was not a canonical non-negative integer — a fact about the caller's own
  // input, which it already has. `unknown_handle` says the parse succeeded and no member of this
  // run answers to it. Both are answered before any stream header, and neither echoes the value.
  'invalid_handle',
  'unknown_handle',
  // 403-03 (D-13, T-403-13 · INVK-05): the resume point's two refusals, kept APART on the
  // `invalid_handle`/`unknown_handle` reasoning one line up. `invalid_last_event_id` says the
  // `Last-Event-ID` header or the `?lastEventId=` parameter was not a canonical non-negative
  // integer — a fact about the caller's own input. `replay_floor` says the parse succeeded and the
  // requested point is BELOW what the bus can still replay; it is the one refusal on this door that
  // carries a second key, because the recovery point is the whole reason it exists (see
  // `RunServiceReplayFloorBodySchema`). Both are answered before any stream header.
  'invalid_last_event_id',
  'replay_floor',
  // 403-03 (D-03, Q3): the `liveUrl` mint's two host-fact refusals, so BOTH doors answer the same
  // words for the same situation. `live_view_unavailable` is a genuine host fact — no live-view
  // composition, or no origin to build a link against — refused by name rather than answered with
  // a URL that resolves to nothing. `live_url_mint_failed` is the mint's flattened 500, keeping its
  // words to itself exactly as `run_start_failed` does and for the same reason.
  'live_view_unavailable',
  'live_url_mint_failed',
] as const

export type RunServiceErrorCode = (typeof RUN_SERVICE_ERROR_CODES)[number]

/**
 * The ONE error body this door writes — a single key carrying a closed code.
 *
 * ONE KEY, DELIBERATELY. A refusal body that varied its SHAPE by route or by reason would be a
 * fingerprinting surface: a caller refused at the door could learn which routes exist or whether a
 * run id is real by diffing the bodies it is refused with. With one key and a closed vocabulary the
 * only thing that varies is the word, and the word that can appear before the route table is
 * reached is `cross_site_refused` and nothing else.
 *
 * It is also why nothing here echoes the caller's input. Naming the offending field, the run id or
 * anything else would each put an attacker-chosen or a host-held string into a body served to a
 * caller this door has not yet admitted.
 */
export const RunServiceErrorBodySchema = z.object({
  error: z.enum(RUN_SERVICE_ERROR_CODES),
}).strict()

export type RunServiceErrorBody = z.infer<typeof RunServiceErrorBodySchema>

/**
 * What a REPLAY-FLOOR refusal answers with — the one body on this door wider than one key.
 *
 * WHY THE ONE-KEY LAW DOES NOT GOVERN HERE. That law exists because a refusal shown to a caller
 * the door has not admitted must not fingerprint the route map or a run id's existence. A 410 is
 * answered only AFTER the same-site guard
 * admitted the caller on the run-service door (a declared credential until 432-21), and only behind
 * the bind guard on the local one — the reader is a
 * party this process has already decided to talk to. And what the second key carries is not a host
 * secret: `earliestAvailableSeq` is a fact about the CALLER'S OWN request, namely the point at
 * which the replay it asked for could have been served.
 *
 * THE FIELD IS SPELLED EXACTLY AS `StreamReplayFloorError.earliestAvailableSeq` AND AS THE BUS'S
 * `ReplayIncompleteError.earliestAvailableSeq`, deliberately: the durable reader (`runs.events`)
 * and the live door name the SAME fact, so a client that learned the word once has learned it
 * everywhere.
 *
 * WITHOUT THE NUMBER THE REFUSAL WOULD BE WORSE THAN NOTHING. A caller told only "gone" can do one
 * of two things: give up, or retry the identical request forever. The number is what makes the
 * refusal actionable — re-attach with `lastEventId = earliestAvailableSeq - 1`, because the caller
 * names the last envelope it has ALREADY observed and this names the first one still available.
 * That subtraction is stated here, and pinned by a cell that reads the
 * floor out of a real refusal and re-attaches with it.
 */
export const RunServiceReplayFloorBodySchema = z.object({
  error: z.literal('replay_floor'),
  earliestAvailableSeq: z.number().int().nonnegative(),
}).strict()

export type RunServiceReplayFloorBody = z.infer<typeof RunServiceReplayFloorBodySchema>

/**
 * The request fields this door REFUSES outright (D-07 / D-12, 401's law carried to the wire).
 *
 * A caller may not name the terms of its own authorization, may not choose the identity its
 * run is addressed by, and may not turn up concurrency on a target whose config owner tuned it.
 * The core's own `REFUSED_RUN_REQUEST_FIELDS` refuses `scope` and `executionContext` a layer down;
 * `runId` joins them HERE because the local dashboard door legitimately supplies one (its queue
 * minted the row) and the remote door legitimately does not — the difference is a property of the
 * door, so it is stated at the door.
 */
export const RUN_SERVICE_REFUSED_REQUEST_FIELDS = ['runId', 'scope', 'executionContext'] as const

/**
 * What a remote caller may say when starting a run: the pattern set, and nothing else.
 *
 * `.strict()`, so an unrecognised key is a typed refusal rather than a silently ignored request —
 * the same law `RunsStartInputSchema` is under. Absent `patterns` means "the configured default
 * set", which is what an argument-less `runs.start` already means.
 */
export const RunServiceStartRequestSchema = z.object({
  patterns: z.array(z.string()).optional(),
}).strict()

export type RunServiceStartRequest = z.infer<typeof RunServiceStartRequestSchema>

/**
 * What `/ok` reports (D-15): measured facts, and no prediction.
 *
 * SHALLOW BUT HONEST. Each field is something this process can observe about ITSELF right now —
 * the service answered, a host is composed, and which contract version these routes implement.
 * 2026-10-01 (432-22, D-12): `authConfigured` is deleted with `services.dashboard.runServiceTokens`.
 * No credential can be configured, so it had read `false` on every answer since 432-21, and a
 * fact that cannot vary is not a measurement. There is no `ready: true`, because a run's success depends on a
 * browser, a model, a network and a target, none of which this route touched. Deep diagnostics
 * (knowledge rungs, embedder health) belong to 407's `doctor` and are deliberately absent.
 *
 * `hostComposed` is measured off the SAME state the invoke path's guard throws on, so a `/ok` that
 * says the host is composed and a `POST /run` that says it is not cannot disagree.
 */
export const RunServiceReadinessSchema = z.object({
  service: z.literal('up'),
  hostComposed: z.boolean(),
  contractVersion: z.literal(RUN_SERVICE_CONTRACT_VERSION),
}).strict()

export type RunServiceReadiness = z.infer<typeof RunServiceReadinessSchema>
