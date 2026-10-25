/**
 * The `@vostride/agent-qa-eval-local/reader` subpath — the proposer's door (414 D-18/D-19/D-20,
 * ROOT-10 SC5).
 *
 * eval-local's MAIN entry is the GATE side: it hands out the committed root as an fs path, the
 * seeding writer, the partition-manifest and run-exclusion writers, the baseline pointer and the
 * gate-side posture — powers that decide what a run is scored against. A proposer must hold none
 * of them. This entry is what it may hold instead, and the arch lint's eval-local reader
 * carve-out (Plan 03) holds every non-cli importer to this spelling.
 *
 * Why NOTHING else may join this file: the subpath is the enforcement boundary, so any value
 * published here is a value a proposer can reach. `openCorpusReader` is the whole surface, and
 * three cells hold it to that — the runtime key-set pin in `__tests__/reader.test.ts`, the
 * never-bar in `__tests__/reader.test-d.ts`, and the source-anchored export-set cell in
 * `packages/arch/src/__tests__/validate-arch.test.ts`. Adding an export
 * here REDs the first and the third BY NAME. That is the intended cost of adding one: a widening
 * of the proposer's reach is a reviewed edit to this file, never a convenience re-export.
 *
 * Types are safe to publish — a type grants no power at runtime — but only these three, because
 * a type naming a private held-out entry would hand the proposer the SHAPE of the unseen set.
 */

export { openCorpusReader } from './corpus-reader.js'
export type { CorpusReader, CorpusReaderLoad, ProposerVisibleCorpusEntry } from './corpus-reader.js'
