import type { InterimNode } from '@vostride/agent-qa-runner'

export interface MobileNode {
  index: number
  type: string
  label?: string
  value?: string
  bounds?: { x: number; y: number; width: number; height: number }
  enabled?: boolean
  children: MobileNode[]
}

// Execute-time record for one builder-minted ref; each field is read by the element resolver.
export interface RefEntry {
  role: string
  name?: string
  bounds?: { x: number; y: number; width: number; height: number }
  nativeType?: string
  value?: string
  editable?: boolean
  /** Android's raw `input-type` bitmask from the observed node. */
  inputType?: number
}

/** Execute-time ref -> resolution record map (adapter-private `lastRefs`). */
export type MobileRefMap = Record<string, RefEntry>

export interface ParsedMobileSource {
  nodes: InterimNode[]
}
