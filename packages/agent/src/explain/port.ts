// The port's citation type has no field a command fits in, so no implementation returns one.

import type { CatalogRow, ExplainCitation } from '@vostride/agent-qa-schema'

// `query` is the one free-text value, so this record goes only to a local append-only log.
export interface ExplainAbstentionRecord {
  readonly query: string
  /** Canonical row ids the deterministic scorer picked — never a model's suggestion. */
  readonly closestRowIds: readonly string[]
}

// An unbound composition refuses by name rather than answering from model memory.
export interface CapabilityCatalogPort {
  // A zero-row catalog is valid: the renderer turns it into the abstention arm.
  loadCatalog(): Promise<readonly CatalogRow[]>

  // A cited id not in `rows` is a ghost, and the renderer abstains for the whole output.
  citeCapabilities(query: string, rows: readonly CatalogRow[]): Promise<ExplainCitation>

  // One counter tick for a grounded answer, with no payload.
  recordAnswered(): void

  /** Append the coverage record, locally. The demand signal for writing the missing doc. */
  recordAbstained(record: ExplainAbstentionRecord): void
}
