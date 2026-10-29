// One meter per step execution; a refused debit never increments, and nothing refills it.

import type { CompoundInputCount, PlannerLimits, StepLimitUsage } from '@vostride/agent-qa-schema'

export class StepLimitMeter {
  private readonly limits: PlannerLimits
  private actions = 0
  private planningCalls = 0
  private verifierCalls = 0
  private judgeCalls = 0

  constructor(limits: PlannerLimits) {
    this.limits = { maxActions: limits.maxActions, maxPlanningTurns: limits.maxPlanningTurns }
  }

  tryDebitAction(): boolean {
    if (this.actionsExhausted()) return false
    this.actions++
    return true
  }

  tryDebitPlanningCall(): boolean {
    if (this.planningExhausted()) return false
    this.planningCalls++
    return true
  }

  actionsExhausted(): boolean {
    return this.actions >= this.limits.maxActions
  }

  planningExhausted(): boolean {
    return this.planningCalls >= this.limits.maxPlanningTurns
  }

  recordVerifierCall(): void {
    this.verifierCalls++
  }

  recordJudgeCall(): void {
    this.judgeCalls++
  }

  get maxActions(): number {
    return this.limits.maxActions
  }

  get maxPlanningTurns(): number {
    return this.limits.maxPlanningTurns
  }

  get actionsUsed(): number {
    return this.actions
  }

  get planningCallsUsed(): number {
    return this.planningCalls
  }

  snapshot(compoundInputs?: readonly CompoundInputCount[]): StepLimitUsage {
    return {
      limits: { ...this.limits },
      actionsUsed: this.actions,
      planningCallsUsed: this.planningCalls,
      verifierCalls: this.verifierCalls,
      judgeCalls: this.judgeCalls,
      ...(compoundInputs !== undefined && compoundInputs.length > 0
        ? { compoundInputs: compoundInputs.map((input) => ({ ...input })) }
        : {}),
    }
  }
}
