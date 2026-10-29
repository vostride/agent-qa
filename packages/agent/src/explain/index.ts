// A local barrel: exporting the renderer would give a surface a second way to compose answers.

export {
  EXPLAIN_ABSTENTION_TEMPLATES,
  catalogRowId,
  invocationForRow,
  renderExplainOutput,
} from './renderer.js'
export type { ExplainRenderContext } from './renderer.js'
export { DEFAULT_CLOSEST_COUNT, closestCapabilities, compareRowIds } from './scorer.js'
export type { CapabilityCatalogPort, ExplainAbstentionRecord } from './port.js'
