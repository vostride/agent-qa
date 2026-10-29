// Holds Playwright's aria-ref, not a list index, so a moved row is followed, not substituted.
export type RefMap = Record<string, {
  nativeRef: string
  role: string
  name: string
  rowText?: string
  bounds?: { x: number; y: number; width: number; height: number }
}>
