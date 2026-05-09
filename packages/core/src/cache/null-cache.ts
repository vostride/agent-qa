import type { ActionCache } from '../agent/types.js'
import type { ActionPlan } from '../schema/action-schema.js'

export class NullActionCache implements ActionCache {
  async get(_stepHash: string, _screenHash: string): Promise<ActionPlan | null> {
    return null
  }
  async set(_stepHash: string, _screenHash: string, _plan: ActionPlan): Promise<void> {}
  async invalidate(_stepHash: string, _screenHash: string): Promise<void> {}
  async getSubAction(_stepHash: string, _index: number): Promise<ActionPlan | null> {
    return null
  }
  async setSubAction(_stepHash: string, _index: number, _plan: ActionPlan): Promise<void> {}
  async invalidateSubActionsFrom(_stepHash: string, _fromIndex: number): Promise<void> {}
}
