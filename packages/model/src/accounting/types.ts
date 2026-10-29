// Types only, from `ai`, never `@ai-sdk/*`.

import type { LanguageModelUsage, ModelMessage } from 'ai'
import type { ModelCapabilities } from '@vostride/agent-qa-schema'

// Policy-free: the caller supplies the budget and pin; `estimate` is optional for standalone tests.
export interface DegradeOptions {
  budget: number
  pin?: (message: ModelMessage, index: number) => boolean
  estimate?: (messages: ModelMessage[]) => number
}

// `ok: false` is the cannot-fit outcome with the hygiene-reduced messages; never throws.
export type DegradeOutcome =
  | { ok: true; messages: ModelMessage[] }
  | { ok: false; reason: 'pinned-content-exceeds-budget'; messages: ModelMessage[] }

// Prompt tokens only; consumed through the runner's provider-neutral port.
export interface TokenAccounting {
  estimate(messages: ModelMessage[]): number
  recordUsage(usage: LanguageModelUsage, messages: ModelMessage[]): void
  getCeilings(): { contextWindow: number; maxOutput: number }
  degrade(messages: ModelMessage[], options: DegradeOptions): DegradeOutcome
}

// `getCapabilities` is read on every call, so a learned window shrink applies next turn.
export interface TokenAccountingOptions {
  getCapabilities: () => ModelCapabilities
  perImageTokens?: number
}
