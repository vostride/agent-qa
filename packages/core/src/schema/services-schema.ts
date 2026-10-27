import { z } from 'zod'
import { SizeString } from './primitives.js'

/**
 * Whether a configured value is an ABSOLUTE `http:`/`https:` URL (408 D-08, WR-04 — T-408-16).
 *
 * FILE-LOCAL, DELIBERATELY, unlike `isLoopbackHost` below, which is exported for the dashboard's
 * bind guard in another package. This one has exactly one decision site — the parse boundary,
 * immediately below. Exporting it would advertise a second place to make the same check, and the
 * whole point of a parse-time guard is that there is no second place: nothing downstream should be
 * re-deciding whether the base is safe.
 *
 * A RELATIVE VALUE IS REFUSED, not resolved. `new URL(value)` with no base throws for
 * `/relative/only` and for `not-a-url`, and the scheme test refuses `javascript:` and `mailto:`
 * — which parse fine and are exactly the shapes that must not reach an `href`.
 */
function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export const DashboardConfigSchema = z.object({
  port: z.number().optional(),
  dbPath: z.string().optional(),
  artifactsDir: z.string().optional(),
  // Phase 387, D-10: where an entity card's `url` points. BOTH optional, so the v52 default
  // is a card with no `url` at all rather than a link to a route nothing serves. The card
  // producer reads these through the masked config reader and renders
  // `ENTITY_URL_ROUTE` (@vostride/agent-qa-schema) against them.
  //
  // They live on the EXISTING `services.dashboard` block rather than on a new top-level
  // `dashboard` key: this project already has one dashboard configuration home, and a second
  // one would be two places an operator could reasonably write the same fact.
  //
  // 2026-09-01 (Phase 408 plan 10, WR-04 — T-408-16): REFINED TO AN ABSOLUTE http(s) URL, because
  // this value stops being a display string in M5. It composes the tokenless live link
  // (`live-link.ts`'s `liveRunLinkOf`, which only strips trailing slashes), and that link is
  // assigned to an `href` INSIDE the served App document — which runs with `allow-scripts` at an
  // opaque origin — as well as appended verbatim to every carrier tool result's model-readable
  // text. A `javascript:` base therefore composed a script-executing anchor. The trust boundary is
  // the operator, so this is not remote-triggerable; the finding is that a URL-shaped value reached
  // an `href` with no scheme check at any hop, and the guard costs one refinement.
  //
  // AT THE PARSE BOUNDARY, so there is exactly one place that decides. The defensive drop at the
  // anchor itself is the SECOND half of the same finding and lives in `app-wrapper.ts`.
  //
  // STILL `.optional()`: an absent base is a real and honest posture — a standalone `agent-qa mcp`
  // with no dashboard — and the carrier result names that absence rather than fabricating a URL.
  // An EMPTY STRING is now REFUSED, which is stricter than before: `""` is not an absence an
  // operator wrote by leaving the key out, it is a value that composes a relative fragment reading
  // as a link and resolving against nothing.
  baseUrl: z.string().refine(
    isAbsoluteHttpUrl,
    { message: 'services.dashboard.baseUrl must be an absolute http(s) URL' },
  ).optional(),
  workspace: z.string().optional(),
  // 2026-10-01 (432-22, D-12/D-22): `runServiceTokens` is deleted. The run service is tokenless
  // since 432-21, and a file that still declares the key gets the normal strict unrecognized-key
  // error, with no migration and no special message. The local doors never needed a credential.
  // The interface the dashboard binds. A plain string, because the pre-listen bind guard refuses
  // any non-loopback value at runtime, as the security refusal it is rather than a config-shape
  // error, and a loopback spelling other than the default (`localhost`, `::1`) stays configurable.
  host: z.string().trim().min(1).optional(),
}).strict()

/**
 * The one member set for "this host is loopback", used by the dashboard's pre-listen bind guard in
 * `startServer`, which refuses a non-loopback dashboard host at runtime with no exemption.
 */
export const LOOPBACK_HOSTS: readonly string[] = Object.freeze(['localhost', '127.0.0.1', '::1'])

/** Whether a configured host names a loopback interface. The one predicate over the one set. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.includes(host.trim())
}

// Whether the dashboard co-hosts the MCP endpoint, and the port it listens on.
export const McpConfigSchema = z.object({
  enabled: z.boolean().optional(),
  port: z.number().int().min(1).max(65535).optional(),
}).strict()

export const CacheConfigSchema = z.object({
  dir: z.string(),
}).strict()

export const AuthStateConfigSchema = z.object({
  dir: z.string().trim().min(1),
}).strict()

export const LoggingConfigSchema = z.object({
  level: z.enum(['silent', 'error', 'warn', 'info', 'debug']),
}).strict()

export const RecordingConfigSchema = z.object({
  enabled: z.boolean().default(true),
  keepFailuresOnly: z.boolean().optional(),
}).strict()

export const AccessibilityConfigSchema = z.object({
  enabled: z.boolean(),
  standard: z.enum(['wcag2a', 'wcag2aa', 'wcag2aaa']).optional(),
  runAfter: z.enum(['every-step', 'navigation', 'test-end']).optional(),
  failOnViolation: z.boolean().optional(),
  disableRules: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
}).strict()

export const VisionServiceSchema = z.object({
  screenshotSize: SizeString.optional(),
  effectiveResolution: z.number().positive().int().optional(),
}).strict()

export const ServicesSchema = z.object({
  dashboard: DashboardConfigSchema.optional(),
  mcp: McpConfigSchema.optional(),
  cache: CacheConfigSchema.optional(),
  authState: AuthStateConfigSchema.optional(),
  logging: LoggingConfigSchema.optional(),
  // Parse omitted containers too, while retaining optional authoring/input compatibility.
  recording: RecordingConfigSchema.prefault({}).optional(),
  accessibility: AccessibilityConfigSchema.optional(),
  vision: VisionServiceSchema.optional(),
}).strict()
