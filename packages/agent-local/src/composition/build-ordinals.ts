// The build-ordinal edge.
//
// Build ordinals and build tags are run-persistence machinery: the ordinal counter and the
// tag map both live in `runner-local` beside the stores that write them, and that is the
// right home. What was wrong was WHO reached them. Two CLI commands named `runner-local`
// directly to resolve a tag and to reserve an ordinal, and a surface naming a persistence
// package is the private power the FUNC-02 firewall exists to remove — the same debt the
// firewall ledger carried for `knowledge-read.ts` and `knowledge-maintain.ts` until this phase.
//
// So the edge moves here, to the composition subtree a surface is already sanctioned to reach
// (`SURFACE_ALLOWED_INTERNAL_PACKAGES`), and nothing else changes: these are re-exports, not
// wrappers. A wrapper would have been a second, composition-local definition of what a build
// ordinal is, and the first time the two disagreed the disagreement would be invisible. The
// composition subtree may name `runner-local` by the arch carve-out (`COMPOSITION_ONLY_PACKAGES`)
// precisely so that edges like this have one legal place to live.
//
// The reach this grants a surface is exactly three names, and each is already reachable by the
// hosts that compose runs — this hands a CLI nothing the daemon did not already have.

export {
  BuildOrdinalReservationError,
  reserveBuildOrdinalForProducts,
  latestBuildOrdinal,
} from '@vostride/agent-qa-runner-local'
export { resolveBuildTag } from '@vostride/agent-qa-runner-local'
