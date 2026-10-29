// `explain`'s host port.
//
// FOUR CAPABILITIES THIS PACKAGE CANNOT NAME, each for a measured reason rather than a stylistic
// one — the `config-mutation/ports.ts` frame, instantiated:
//
//   loadCatalog       — the committed catalog artifact is read by `loadCapabilityCatalog` in
//                       `packages/cli`, which walks the package root and touches `fs`. This package
//                       is storageNeutral and may not. Crossing it as DATA (a `CatalogRow[]`) also
//                       keeps 398-01's ONE read path intact: nothing here parses JSON, so no second
//                       reader can appear behind this seam.
//   citeCapabilities  — the model half. It is a port and not an inline call because `packages/agent`
//                       receives a `LanguageModel` already built at the host (the chat planner's
//                       precedent) and because a doctored implementation of exactly this method is
//                       how D-12's ghost-citation proof is driven without a network.
//   recordAnswered    — a counter at the analytics seam. Host-side by the same rule the analytics
//                       package states: the DNT decision is made once, at a composition root.
//   recordAbstained   — appends the typed coverage record to the local append-only log under
//                       `.agent-qa/`. A file write, so: not here.
//
// THE PORT NEVER CARRIES A COMMAND, IN EITHER DIRECTION. `citeCapabilities` answers an
// `ExplainCitation`, whose schema has no field a command string fits in (see
// `packages/schema/src/explain.ts`). That is D-10's mechanism and it lives in the DTO, so no
// implementation of this interface — however written, however prompted — can hand a command back.
// The exact slash and alias forms are therefore never in the prompt either: they are the
// renderer's business, downstream of every answer this port gives.

import type { CatalogRow, ExplainCitation } from '@vostride/agent-qa-schema'

/**
 * The abstention coverage record.
 *
 * `query` is verbatim, and it is why this record is written to a LOCAL append-only log and to
 * nothing else: it is the one free-text value in the feature. SURF-FUT-02 reads the log later to
 * decide whether docs-RAG has demand. An implementation that forwards this to a network sink is
 * the D-14 no-free-text law broken, not a configuration choice.
 */
export interface ExplainAbstentionRecord {
  readonly query: string
  /** Canonical row ids the deterministic scorer picked — never a model's suggestion. */
  readonly closestRowIds: readonly string[]
}

/**
 * What the `explain` op needs from its host, and the whole of it.
 *
 * Bound at `composeLocalAgent()` by plan 07. An unbound composition refuses BY NAME
 * through `FunctionNotBoundError` rather than degrading to a model-only answer — an explain that
 * silently loses its catalog is precisely an explain that answers from model memory.
 */
export interface CapabilityCatalogPort {
  /**
   * Every catalog row, as data.
   *
   * A PRODUCED zero-row catalog is a valid answer here and must not be an error (398-01's loader
   * makes the same distinction): the renderer turns zero rows into the abstention arm, which is
   * SC-2's "an empty catalog abstains rather than inventing" at the seam where it is decidable.
   */
  loadCatalog(): Promise<readonly CatalogRow[]>

  /**
   * The model's selection over the rows it was handed — row ids only.
   *
   * Implementations MUST pass `rows` as the grounding data. Anything cited that is not in `rows`
   * is a ghost id, and the renderer answers ghosts with a whole-output abstention, so a confused
   * or injected model degrades to "I am not certain" rather than to a fabricated command.
   */
  citeCapabilities(query: string, rows: readonly CatalogRow[]): Promise<ExplainCitation>

  /** One counter tick for a grounded answer. No payload — D-14 permits a count and nothing more. */
  recordAnswered(): void

  /** Append the coverage record, locally. The demand signal for writing the missing doc. */
  recordAbstained(record: ExplainAbstentionRecord): void
}
