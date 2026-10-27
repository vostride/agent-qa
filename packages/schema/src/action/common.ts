import type { Scroll, WaitFor } from './params'
import type { NoPlatform, RefTargeted } from './shared'

type AssertValueOp = 'isNull' | 'isDefined' | 'equals' | 'notEquals' | 'gt' | 'lt' | 'contains'

type ExtractAIField = {
  name: string
  type: 'string' | 'number' | 'boolean' | 'array' | 'object'
  description: string
  item?: { type: 'string' | 'number' | 'boolean' | 'object' }
}

export type CommonAction = NoPlatform & (
  | { type: 'assertAI'; claim: string; mode: 'multimodal' | 'visual' | 'text' }
  | { type: 'assertValue'; source: 'url' | 'storage' | 'network' | 'expr-result'; op: AssertValueOp; expected?: string }
  | { type: 'assertValue'; expr: string; op: AssertValueOp; expected?: string }
  | { type: 'extractAI'; query: string; schema: ExtractAIField[]; scope: 'run' | 'global' }
  | ({ type: 'waitFor' } & WaitFor)
  | { type: 'delay'; ms: number }
  | ({ type: 'scroll' } & Scroll)
  | ({ type: 'clearText' } & RefTargeted)
  | { type: 'reportValue'; value: string }
  | { type: 'openApp'; appName: string }
  | { type: 'openApp'; bundleId: string }
  | { type: 'executeScript'; command: string; args?: unknown }
  | { type: 'setVariable'; name: string; value: string }
  | { type: 'keypress'; keys: string[]; mode: 'press' | 'down' | 'up'; convertPlatformKeys?: boolean }
)
