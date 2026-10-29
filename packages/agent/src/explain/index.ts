// `explain`'s deterministic core.
//
// A LOCAL barrel, deliberately not the package barrel. `packages/agent/src/index.ts` is pinned by
// the arch export assertion and is the surface a host may reach; the op that plan 07 registers is
// what belongs there, not the parts it is assembled from. Exporting the renderer publicly would
// hand a surface a second way to compose an explain answer, which is the same mistake the function
// layer's barrel note refuses for `invoke`.

export {
  EXPLAIN_ABSTENTION_TEMPLATES,
  catalogRowId,
  invocationForRow,
  renderExplainOutput,
} from './renderer.js'
export type { ExplainRenderContext } from './renderer.js'
export { DEFAULT_CLOSEST_COUNT, closestCapabilities, compareRowIds } from './scorer.js'
export type { CapabilityCatalogPort, ExplainAbstentionRecord } from './port.js'
