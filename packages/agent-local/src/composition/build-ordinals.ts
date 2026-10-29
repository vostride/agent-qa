// Re-exports, not wrappers, so a surface reaches `runner-local`'s ordinals without naming it.

export {
  BuildOrdinalReservationError,
  reserveBuildOrdinalForProducts,
  latestBuildOrdinal,
} from '@vostride/agent-qa-runner-local'
export { resolveBuildTag } from '@vostride/agent-qa-runner-local'
