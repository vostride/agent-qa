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

/**
 * Execute-time resolution record for a single builder-minted ref. Reconstructed by
 * `buildRefEntries` from the interim nodes + the builder's ref->node binding, this is
 * how the mobile adapters keep the v1 `lastRefs` locator pattern alive after the
 * shared builder took over ref minting. Every field here is one that
 * `element-resolver.ts`/`gestures.ts` actually read at execute time.
 */
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

/** parseMobileSource result — a plain interim-node list; ref minting, tree rendering,
 * and the viewport-summary header all moved into the shared builder (Plan 352-01). */
export interface ParsedMobileSource {
  nodes: InterimNode[]
}
