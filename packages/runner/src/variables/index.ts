// Barrel for the runner-owned variables subsystem: run/test-scoped
// VariableStore, step-text interpolation, and the capture extractors. The extraction
// vocabulary types (ExtractorInput/CaptureResult/VariableExtractor/ExtractionMethod)
// stay in loop/types.ts and are exported from the package root there; the env-file
// codec stays in hooks/env-file.ts (Plan 04). LLMVariableExtractor lives beside the
// asserter in loop/ — re-exported here so the full surface is one import.
export { VariableStore } from './store.js'
export type { VariableSource, VariableStoreOptions } from './store.js'
export { interpolateVariables, interpolateVariablesWithProvenance, findUnresolvedTemplates, findBareVariables } from './interpolate.js'
export type { InterpolationWithProvenance } from './interpolate.js'
export { ExplicitExtractor, createExtractor } from './extractor.js'
export { LLMVariableExtractor, ExtractionResultSchema } from '../loop/llm-variable-extractor.js'
