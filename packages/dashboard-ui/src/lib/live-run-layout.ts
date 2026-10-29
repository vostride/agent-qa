/**
 * The live run page's two arrangements.
 *
 * Docked: the step list and the preview side by side. Stacked, below 768 px of the page's own
 * measured width: the preview on top at full width and the step list beneath it. The switch
 * changes the panels' ids and the Group's orientation, never the Group's key (426-11's idiom), so
 * react-resizable-panels keeps a remembered layout per arrangement and nothing inside the Group
 * is remounted by the Group itself.
 */

export type LiveRunLayout = 'docked' | 'stacked'

// prettier-ignore
export const LIVE_RUN_LAYOUTS = [
  'docked',
  'stacked',
] as const satisfies readonly LiveRunLayout[]

/** 48rem, the same step the run detail page stacks its feedback composer at. */
export const LIVE_RUN_STACK_BELOW_PX = 768

/** An unmeasured page (width 0) is docked, so the first paint before the observer reports never moves. */
export function liveRunLayoutOf(width: number): LiveRunLayout {
  return width > 0 && width < LIVE_RUN_STACK_BELOW_PX ? 'stacked' : 'docked'
}

export interface LiveRunPanelIds {
  preview: string
  steps: string
}

const LIVE_RUN_PANEL_IDS = {
  preview: 'live-preview',
  steps: 'live-steps',
} as const satisfies LiveRunPanelIds

const LIVE_RUN_STACKED_PANEL_IDS = {
  preview: 'live-preview-stacked',
  steps: 'live-steps-stacked',
} as const satisfies LiveRunPanelIds

export function liveRunPanelIds(layout: LiveRunLayout): LiveRunPanelIds {
  return layout === 'stacked' ? LIVE_RUN_STACKED_PANEL_IDS : LIVE_RUN_PANEL_IDS
}
