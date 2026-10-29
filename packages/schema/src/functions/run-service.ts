// The router lives in dashboard-server and the composition in the CLI, so the wire words live here.

import { z } from 'zod'

// Versioned apart from the event envelope; it moves when the routes or their answers change.
export const RUN_SERVICE_CONTRACT_VERSION = 2

/**
 * Every code any non-2xx answer on this door carries. Closed, and shared across all routes.
 *
 * Two words can be answered before the route table: `cross_site_refused` for a request from
 * another site or naming a foreign Host, and `unsupported_media_type` for a body whose
 * Content-Type is not application/json.
 */
export const RUN_SERVICE_ERROR_CODES = [
  'cross_site_refused',
  'refused_request_field',
  'invalid_request_body',
  'unknown_run',
  'unknown_route',
  'run_start_failed',
  'replay_unavailable',
  // `invalid_handle` is a malformed parameter, `unknown_handle` a valid one no member answers to.
  'invalid_handle',
  'unknown_handle',
  // `replay_floor`: the resume point is below what the bus still replays; it carries a second key.
  'invalid_last_event_id',
  'replay_floor',
  // `live_view_unavailable`: no live view here; `live_url_mint_failed`: a 500 that hides why.
  'live_view_unavailable',
  'live_url_mint_failed',
  // A request body whose Content-Type is not application/json.
  'unsupported_media_type',
] as const

export type RunServiceErrorCode = (typeof RUN_SERVICE_ERROR_CODES)[number]

/**
 * The ONE error body this door writes — a single key carrying a closed code.
 *
 * ONE KEY, DELIBERATELY. A refusal body that varied its SHAPE by route or by reason would be a
 * fingerprinting surface: a caller refused at the door could learn which routes exist or whether a
 * run id is real by diffing the bodies it is refused with. With one key and a closed vocabulary the
 * only thing that varies is the word, and the words that can appear before the route table is
 * reached are `cross_site_refused` and `unsupported_media_type`.
 *
 * It is also why nothing here echoes the caller's input. Naming the offending field, the run id or
 * anything else would each put an attacker-chosen or a host-held string into a body served to a
 * caller this door has not yet admitted.
 */
export const RunServiceErrorBodySchema = z.object({
  error: z.enum(RUN_SERVICE_ERROR_CODES),
}).strict()

export type RunServiceErrorBody = z.infer<typeof RunServiceErrorBodySchema>

// Re-attach with `lastEventId = earliestAvailableSeq - 1`: a caller names the last one it saw.
export const RunServiceReplayFloorBodySchema = z.object({
  error: z.literal('replay_floor'),
  earliestAvailableSeq: z.number().int().nonnegative(),
}).strict()

export type RunServiceReplayFloorBody = z.infer<typeof RunServiceReplayFloorBodySchema>

/**
 * The request fields this door refuses: a caller may not choose the run id its run is addressed
 * by. The local dashboard door supplies one from its queue and the remote door does not.
 */
export const RUN_SERVICE_REFUSED_REQUEST_FIELDS = ['runId'] as const

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

// `hostComposed` reads the state the invoke guard throws on, so `/ok` and `POST /run` agree.
export const RunServiceReadinessSchema = z.object({
  service: z.literal('up'),
  hostComposed: z.boolean(),
  contractVersion: z.literal(RUN_SERVICE_CONTRACT_VERSION),
}).strict()

export type RunServiceReadiness = z.infer<typeof RunServiceReadinessSchema>
