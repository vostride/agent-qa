// Adapter-private and holds no position, so a moved row is followed, not substituted.
export type RefMap = Record<string, {
  nativeRef: string
  role: string
  name: string
  rowText?: string
  bounds?: { x: number; y: number; width: number; height: number }
}>
