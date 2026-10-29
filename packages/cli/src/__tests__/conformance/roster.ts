// A closed set: a door arrives as a reviewed row and adapter; the catalogue invokes nothing.

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
  // The chat host: the planner and the deterministic resolver, one surface at one prompt.
  Object.freeze({ id: 'chat', adapter: chatSurfaceAdapter }),
  // The MCP server: the adapter folds a live listing back into op ids through the mapping.
  Object.freeze({ id: 'mcp', adapter: mcpSurfaceAdapter }),
  // Driven through the command: its listing passes a root, a caller mint and a projection.
  Object.freeze({ id: 'fn', adapter: fnSurfaceAdapter }),
  // Narrow by design: its `notApplicable` list says which capability classes it cannot serve.
  Object.freeze({ id: 'run-service', adapter: runServiceSurfaceAdapter }),
] as const satisfies readonly SurfaceRosterEntry[])
