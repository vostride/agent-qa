import type { ElementInfo } from '../types/platform.js'

export interface MobileNode {
  index: number
  type: string
  label?: string
  value?: string
  bounds?: { x: number; y: number; width: number; height: number }
  enabled?: boolean
  children: MobileNode[]
}

export type MobileRefMap = Record<string, {
  role: string
  name?: string
  nth?: number
  bounds?: { x: number; y: number; width: number; height: number }
  nativeType?: string
  value?: string
}>

export interface ParsedMobileTree {
  tree: string
  elements: ElementInfo[]
  refs: MobileRefMap
}
