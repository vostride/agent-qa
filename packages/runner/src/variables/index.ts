// Re-exports LLMVariableExtractor so the full variables surface is one import.
export { VariableStore } from './store.js'
export type { VariableSource, VariableStoreOptions } from './store.js'
export { interpolateVariables, interpolateVariablesWithProvenance, findUnresolvedTemplates, findBareVariables } from './interpolate.js'
export type { InterpolationWithProvenance } from './interpolate.js'
export { ExplicitExtractor, createExtractor } from './extractor.js'
export { LLMVariableExtractor, ExtractionResultSchema } from '../loop/llm-variable-extractor.js'
