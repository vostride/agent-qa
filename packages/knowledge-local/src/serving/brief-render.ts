// the shared brief renderer lives in runner.
// Keep knowledge-local's serving import paths stable through these re-exports.
export {
  CHARS_PER_TOKEN_ESTIMATE,
  estimateRenderedServingCost,
  renderBriefLine,
  renderCautionLine,
  renderCautionSummary,
} from '@vostride/agent-qa-runner'
export type { RenderedCautionLine } from '@vostride/agent-qa-runner'
