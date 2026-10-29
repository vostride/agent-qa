// Adapter-private native binding per observed ref: Playwright's aria-ref handle the
// dispatch acts through, and the observed role, exact name and row text the pre-dispatch check
// compares against the current page. No position is kept.
export type RefMap = Record<string, {
  nativeRef: string
  role: string
  name: string
  rowText?: string
  bounds?: { x: number; y: number; width: number; height: number }
}>
