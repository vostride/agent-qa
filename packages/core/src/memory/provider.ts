import type { MemoryIndexParams } from './memory-index.js'
import type { BaseObservation, SuiteObservation } from './schema.js'

export interface MemoryObservationSnippet {
  id: string
  title: string
  content: string
  trust: number
}

export interface MemoryQueryResult {
  observations: MemoryObservationSnippet[]
  formatted: string
}

export interface MemoryProvider {
  init(params: MemoryIndexParams): Promise<void>
  queryForStep(stepText: string, stepIndex: number): MemoryQueryResult | null
  destroy(): void

  acquireLock(): Promise<void>
  releaseLock(): Promise<void>
  writeObservation(tier: 'products' | 'suites' | 'tests', scope: string, data: BaseObservation | SuiteObservation): Promise<string>
  deleteObservation(tier: 'products' | 'suites' | 'tests', scope: string, id: string): Promise<void>
  searchForDuplicates(content: string): MemoryObservationSnippet[]
  getAllObservations(): MemoryObservationSnippet[]

  getInjectedObservations(stepIndex: number): string[]

  // Phase 161 stub (dashboard analytics)
  getRunAnalytics(): unknown
}
