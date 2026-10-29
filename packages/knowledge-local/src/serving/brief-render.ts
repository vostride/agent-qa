// The brief renderer lives in runner; these re-exports keep serving import paths stable.
export {
  CHARS_PER_TOKEN_ESTIMATE,
  estimateRenderedServingCost,
  renderBriefLine,
  renderCautionLine,
  renderCautionSummary,
} from '@vostride/agent-qa-runner'
export type { RenderedCautionLine } from '@vostride/agent-qa-runner'
