// Who acts, not which surface: `cli` serves people and scheduled jobs alike, so it cannot say who.
export const FUNCTION_CALLER_ORIGINS = ['human', 'agent'] as const

export type FunctionCallerOrigin = (typeof FUNCTION_CALLER_ORIGINS)[number]

// No field here is a permission input; `invokeFunction` and the registry read none of them.
export interface FunctionCaller {
  /**
   * Coded originating surface, e.g. 'cli' or 'mcp'. Attribution and diagnostics only;
   * never a permission input.
   */
  surface: string
  // Minted by the composition root and read only by receipts and presentation; it grants nothing.
  origin: FunctionCallerOrigin
}

